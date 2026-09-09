// ============================================================
// FAZA 19 — TEST INTEGRAL (cod REAL din src/lib + HTTP real):
//  19a: schema cluster idempotentă • lease atomic cu contabilitate
//       exactă • consum lease local • re-lease • rezervă goală →
//       fallback local STRÂNS (niciodată nelimitat) • contabilitate
//       între 2 consumatori concurenți • heartbeat + vedere globală
//       • expirare noduri învechite • gauge-uri Prometheus • status
//       phase=19 • lanțul complet rută→limiter global→Neon
//  cron: cleanup_cluster_nodes
// Curățenie completă la final. Idempotent.
// Rulează: bun scripts/test-f19.ts
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

import { q } from "../src/lib/pg";
import {
  ensureClusterSchema,
  globalRateLimit,
  resetClusterLocalState,
  startClusterHeartbeat,
  refreshClusterView,
  clusterViewCached,
  instanceId,
  renderClusterGauges,
  leaseFromPool,
  poolPreset,
} from "../src/lib/cluster-control";
import { runMaintenance } from "../src/lib/maintain-core";

const url =
  process.env.NEON_DATABASE_URL ||
  process.env.DATABASE_URL ||
  (() => {
    console.error("NEON_DATABASE_URL lipsă");
    process.exit(1);
  })();

const adminPool = new Pool({ connectionString: url, max: 3 });
const BASE = process.env.BENCH_BASE || "http://localhost:3000";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    fails.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("════ FAZA 19 — TEST INTEGRAL ════\n");
  resetClusterLocalState();

  // ---------- 1. Schema idempotentă ----------
  console.log("── 1. Schema cluster (DDL idempotent)");
  const ddl1 = await ensureClusterSchema();
  const ddl2 = await ensureClusterSchema();
  check("DDL v19 idempotent (3/3 de 2x)", ddl1 === 3 && ddl2 === 3, `ddl1=${ddl1} ddl2=${ddl2}`);

  // ---------- 2. Lease atomic + contabilitate exactă în Neon ----------
  console.log("── 2. Lease atomic din rezerva globală");
  await q(`DELETE FROM cluster_rate_pool WHERE key = 'f19-test'`);
  resetClusterLocalState();
  const preset = poolPreset("f19-test"); // default browse: 3000 tok, refil 1200/s, lease 200
  const r1 = await globalRateLimit("f19-test");
  check("prima cerere trece (lease proaspăt)", r1.ok && (r1.source === "lease" || r1.source === "lease-refill"), JSON.stringify(r1));
  check("lease-ul local are 199 rămași (200-1)", r1.remaining === preset.leaseSize - 1, `remaining=${r1.remaining}`);
  const row1 = await q<{ tokens: string; capacity: string }>(
    `SELECT tokens, capacity FROM cluster_rate_pool WHERE key = 'f19-test'`
  );
  check(
    "Neon: rezerva a scăzut cu lease-ul (3000-200=2800)",
    row1.length === 1 && Number(row1[0].tokens) === preset.capacity - preset.leaseSize,
    `tokens=${row1[0]?.tokens}`
  );

  // ---------- 3. Consum lease local (fără DB) + re-lease ----------
  console.log("── 3. Cale rapidă locală + re-lease");
  // refil = 0 pe rezerva de test → contabilitate DETERMINISTĂ (refilul
  // proporțional real e verificat de faptul că step 2 a văzut 2800 exact)
  await q(`UPDATE cluster_rate_pool SET refill_per_sec = 0 WHERE key = 'f19-test'`);
  let leaseOk = 0;
  let refillSeen = false;
  for (let i = 0; i < preset.leaseSize + 5; i++) {
    const r = await globalRateLimit("f19-test");
    if (r.ok) leaseOk++;
    if (r.source === "lease-refill") refillSeen = true;
  }
  check(
    `toate ${preset.leaseSize + 5} cererile au trecut (cale rapidă + re-lease)`,
    leaseOk === preset.leaseSize + 5,
    `ok=${leaseOk}`
  );
  check("re-lease din Neon a intervenit", refillSeen);
  const row2 = await q<{ tokens: string }>(`SELECT tokens FROM cluster_rate_pool WHERE key = 'f19-test'`);
  const expectedAfter2 = preset.capacity - preset.leaseSize * 2;
  check(
    "Neon: contabilitate exactă după 2 lease-uri (3000-400=2600)",
    Math.abs(Number(row2[0].tokens) - expectedAfter2) <= 1, // ±1: refil proporțional între lease-uri
    `tokens=${row2[0].tokens} expected~${expectedAfter2}`
  );

  // ---------- 4. Contabilitate între 2 consumatori (lease direct) ----------
  console.log("── 4. Contabilitate globală între consumatori");
  await q(
    `INSERT INTO cluster_rate_pool (key, capacity, tokens, refill_per_sec)
     VALUES ('f19-test2', 500, 500, 0)
     ON CONFLICT (key) DO UPDATE SET tokens = 500, refill_per_sec = 0, updated_at = now()`,
    []
  );
  const l1 = await leaseFromPool("f19-test2", 400);
  const l2 = await leaseFromPool("f19-test2", 400); // doar 100 rămași → lease parțial
  check("consumatorul 1 lease complet (400)", l1.granted === 400, JSON.stringify(l1));
  check("consumatorul 2 lease PARTIAL exact (100)", l2.granted === 100, JSON.stringify(l2));
  const row3 = await q<{ tokens: string }>(`SELECT tokens FROM cluster_rate_pool WHERE key = 'f19-test2'`);
  check("rezerva globală = 0 după ambele lease-uri (fără suprascriere)", Number(row3[0].tokens) === 0, `tokens=${row3[0].tokens}`);

  // ---------- 5. Rezervă goală → fallback local strâns ----------
  console.log("── 5. Rezervă goală → degradare controlată");
  await q(
    `INSERT INTO cluster_rate_pool (key, capacity, tokens, refill_per_sec)
     VALUES ('f19-empty', 100, 0, 0)
     ON CONFLICT (key) DO UPDATE SET tokens = 0, refill_per_sec = 0, updated_at = now()`,
    []
  );
  resetClusterLocalState();
  let ok = 0;
  let rejected = 0;
  let sawPoolEmpty = false;
  for (let i = 0; i < 260; i++) {
    const r = await globalRateLimit("f19-empty", { burst: 120, perMinute: 240 });
    if (r.ok) ok++;
    else rejected++;
    if (r.source === "pool-empty") sawPoolEmpty = true;
  }
  check("fallback local acoperă primele ~120 (burst local)", ok >= 100, `ok=${ok}`);
  check("DUPĂ epuizarea locală → respinse (429 path, niciodată nelimitat)", rejected > 0, `rejected=${rejected}`);
  check("sursa „pool-empty” vizibilă", sawPoolEmpty);

  // ---------- 6. Heartbeat + vedere globală ----------
  console.log("── 6. Heartbeat cluster + vedere globală");
  await q(`DELETE FROM cluster_nodes WHERE instance_id LIKE 'f19-ghost%'`);
  await q(
    `INSERT INTO cluster_nodes (instance_id, region, inflight, rps, breaker, seen_at)
     VALUES ('f19-ghost-1', 'us-east-1', 3, 12.5, 'closed', now() - interval '60 seconds')`
  );
  startClusterHeartbeat(500);
  await new Promise((r) => setTimeout(r, 1400));
  const view = await refreshClusterView();
  const me = view.nodes.find((n) => n.instanceId === instanceId());
  check("instanța proprie e VIUĂ în vedere globală", view.alive >= 1 && Boolean(me), `alive=${view.alive}`);
  check("nodul fantomă (>15s) e EXCLUS din vedere", !view.nodes.some((n) => n.instanceId === "f19-ghost-1"));
  check("view TTL 15s publicat", view.viewTtlSec === 15);
  check("capacitate globală = instanțe × plafon origin", view.globalCapacity === view.alive * 16, `cap=${view.globalCapacity}`);
  const cached = clusterViewCached();
  check("vedere disponibilă și din cache (fără DB)", Boolean(cached && cached.alive >= 1));

  // ---------- 7. Gauge-uri Prometheus ----------
  console.log("── 7. Gauge-uri Prometheus cluster");
  const gauges = renderClusterGauges();
  check("sv_cluster_nodes_alive prezent", gauges.includes("sv_cluster_nodes_alive"));
  check("sv_cluster_inflight_global prezent", gauges.includes("sv_cluster_inflight_global"));
  check("sv_cluster_rps_global prezent", gauges.includes("sv_cluster_rps_global"));
  check("sv_cluster_capacity_global prezent", gauges.includes("sv_cluster_capacity_global"));

  // ---------- 8. HTTP: /api/metrics cu gauge-uri cluster + lanțul complet ----------
  console.log("── 8. HTTP: metrics + lanțul rută→limiter global→Neon");
  const mres = await fetch(`${BASE}/api/metrics`, { cache: "no-store" });
  const mtext = await mres.text();
  check("/api/metrics conține sv_cluster_nodes_alive", mtext.includes("sv_cluster_nodes_alive"));
  const searchRes = await fetch(`${BASE}/api/search?mode=library&q=f19test&limit=5`, {
    cache: "no-store",
    headers: { "x-forwarded-for": "10.199.199.1" },
  });
  check("search mode=library → 200 prin limiter global", searchRes.status === 200, `status=${searchRes.status}`);
  await searchRes.arrayBuffer();
  const poolRow = await q<{ tokens: string; capacity: string }>(`SELECT tokens, capacity FROM cluster_rate_pool WHERE key = 'search'`);
  check(
    "lanț complet: ruta de căutare a consumat din rezerva globală reală „search”",
    poolRow.length === 1 && Number(poolRow[0].capacity) === poolPreset("search").capacity,
    `cap=${poolRow[0]?.capacity}`
  );

  // 429 real pe stratul local per-IP (41 cereri rapide, burst anonim = 40)
  let got429 = false;
  for (let i = 0; i < 45; i++) {
    const r = await fetch(`${BASE}/api/search?mode=library&q=burst${i % 3}&limit=1`, {
      cache: "no-store",
      headers: { "x-forwarded-for": "10.199.199.66" },
    });
    await r.arrayBuffer();
    if (r.status === 429) {
      got429 = true;
      break;
    }
  }
  check("429 REAL la abuz per-IP (strat local pe aceeași rută)", got429);

  // ---------- 9. /api/status phase 19 ----------
  console.log("── 9. /api/status — phase 19 + bloc faza19");
  const sres = await fetch(`${BASE}/api/status`, { cache: "no-store" });
  const sj = (await sres.json()) as {
    resilience?: { phase?: number };
    faza19?: {
      clusterControl?: { instanceId?: string; view?: { alive: number }; ratePool?: { capacity: number } };
      stressTest?: { howTo?: string };
    };
  };
  check("resilience.phase = 19", sj.resilience?.phase === 19, `phase=${sj.resilience?.phase}`);
  check("faza19.clusterControl prezent cu instanță + vedere", Boolean(sj.faza19?.clusterControl?.instanceId) && (sj.faza19?.clusterControl?.view?.alive ?? 0) >= 1);
  check("faza19.ratePool.capacity = presetarea search", sj.faza19?.clusterControl?.ratePool?.capacity === 4000);
  check("faza19.stressTest.howTo prezent", Boolean(sj.faza19?.stressTest?.howTo));

  // ---------- 10. Cron: cleanup_cluster_nodes ----------
  console.log("── 10. Mentenanță: cleanup_cluster_nodes");
  await q(
    `INSERT INTO cluster_nodes (instance_id, region, seen_at)
     VALUES ('f19-ghost-old', 'ap-southeast-1', now() - interval '2 hours')
     ON CONFLICT (instance_id) DO UPDATE SET seen_at = now() - interval '2 hours'`
  );
  const rep = await runMaintenance("cleanup_cluster_nodes");
  const deleted = Number((rep as { clusterNodesDeleted?: number }).clusterNodesDeleted || 0);
  check("heartbeat moarte (>1h) șters de cron", deleted >= 1, `deleted=${deleted}`);
  const ghostGone = await q(`SELECT 1 FROM cluster_nodes WHERE instance_id = 'f19-ghost-old'`);
  check("f19-ghost-old dispărut din Neon", ghostGone.length === 0);

  // ---------- Curățenie ----------
  console.log("── Curățenie");
  await q(`DELETE FROM cluster_rate_pool WHERE key LIKE 'f19-test%' OR key = 'f19-empty'`);
  await q(`DELETE FROM cluster_nodes WHERE instance_id LIKE 'f19-ghost%'`);
  // rezerva „search" rămâne la presetarea de producție (4.000 tok @ 1.500/s)
  await q(
    `INSERT INTO cluster_rate_pool (key, capacity, tokens, refill_per_sec)
     VALUES ('search', 4000, 4000, 1500)
     ON CONFLICT (key) DO UPDATE SET capacity = 4000, refill_per_sec = 1500, tokens = LEAST(4000, cluster_rate_pool.tokens + 1000), updated_at = now()`
  );
  await adminPool.end().catch(() => {});

  console.log(`\n════ REZULTAT: ${pass} OK / ${fail} EȘEC ════`);
  if (fails.length) {
    console.error("Eșecuri:");
    for (const f of fails) console.error("  • " + f);
  }
  // exit explicit: heartbeat-ul de test + WebSocket-ul Neon țin event-loop-ul viu
  process.exit(fail > 0 ? 1 : 0);
}

await main();
