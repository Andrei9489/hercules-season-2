// FAZA 15 — TEST INTEGRAL SHARDING MULTI-COMPUTE cu codul REAL din src/lib
// (nu copii ale logicii — modulele reale: neon-search.ts, shards.ts, pg.ts)
// Verifică: distribuție hash, insert rutat pe shard remote, hartă de rutare,
// dedup cross-shard, scatter-gather căutare combinată din 2 shard-uri,
// rezolvare ID cross-compute, health probe. Curățenie completă la final.
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

import { insertContent, searchLibrary, invalidateSearchCache } from "../src/lib/neon-search";
import {
  pickShardFor,
  getShards,
  getActiveShards,
  shardMapLookup,
  shardMapByRemoteId,
  shardQuery,
  shardMapUpsert,
  probeAllShards,
  shardsStatus,
  invalidateShardRegistry,
} from "../src/lib/shards";
import { q } from "../src/lib/pg";

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const SHARD_NAME = "shard-b-eu-central-1";
const shardUrl = new URL(url);
shardUrl.pathname = "/shard_b";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TAG = `f15test${Date.now().toString(36)}`;
const testIds: string[] = []; // toate external_id-urile create — pentru cleanup complet

async function main() {
  const shardDb = new Pool({ connectionString: shardUrl.toString(), max: 2 });

  // ===== SETUP: înregistrare shard_b în registry (real, în Neon) =====
  console.log("\n SETUP — înregistrare shard_b în registry");
  const existing = await q<{ id: number }>(`SELECT id FROM shards WHERE name = $1`, [SHARD_NAME]);
  let shardId: number;
  if (existing[0]) {
    await q(`UPDATE shards SET state = 'active', dsn = $2 WHERE id = $1`, [Number(existing[0].id), shardUrl.toString()]);
    shardId = Number(existing[0].id);
  } else {
    const ins = await q<{ id: number }>(
      `INSERT INTO shards (name, kind, dsn, region, weight, state, max_rows)
       VALUES ($1, 'remote', $2, 'eu-central-1', 1, 'active', 400000000) RETURNING id`,
      [SHARD_NAME, shardUrl.toString()]
    );
    shardId = Number(ins[0].id);
  }
  invalidateShardRegistry();
  const active = await getActiveShards();
  check("registry: 2 shard-uri active", active.length === 2, active.map((s) => s.name).join(" + "));

  try {
    let extLocal = "";
    let extRemote = "";
    // ===== TEST 1: distribuție hash ponderată =====
    console.log("\n TEST 1 — distribuție hash pe shard-uri (2.000 external_ids)");
    const dist = new Map<number, number>();
    for (let i = 0; i < 2000; i++) {
      const s = await pickShardFor(`user:probe-${i}-${TAG}`);
      dist.set(s.id, (dist.get(s.id) || 0) + 1);
    }
    const d1 = dist.get(active[0].id) || 0;
    const d2 = dist.get(active[1]?.id || -1) || 0;
    check("ambele shard-uri primesc trafic", d1 > 0 && d2 > 0, `${active[0].name}: ${d1} • ${active[1]?.name}: ${d2}`);
    const ratio = Math.min(d1, d2) / Math.max(d1, d2);
    check("distribuție aproximativ uniformă (w=1:1)", ratio > 0.8, `raport ${ratio.toFixed(2)}`);

    // găsește external_ids care hash-uiesc pe fiecare shard
    for (let i = 0; i < 5000 && (!extLocal || !extRemote); i++) {
      const cand = `user:${TAG}-route-${i}`;
      const s = await pickShardFor(cand);
      if (s.kind === "local" && !extLocal) extLocal = cand;
      if (s.kind === "remote" && !extRemote) extRemote = cand;
    }
    testIds.push(extLocal, extRemote);
    check("external_ids rutate identificate", Boolean(extLocal && extRemote), `local + remote găsite`);

    // ===== TEST 2: insert rutat pe shard remote + hartă =====
    console.log("\n TEST 2 — insertContent rutat pe compute-ul remote");
    const remoteHit = await insertContent({
      externalId: extRemote,
      title: `ShardTesting Remote ${TAG}`,
      description: "conținut de test pe compute-ul remote",
      contentType: "video",
      provider: "f15-test",
      sourceType: "url",
      sourceUrl: "https://example.org/f15-remote",
    });
    check("insert remote reușit", Boolean(remoteHit), remoteHit ? `id remote=${remoteHit.id}` : "");

    const localHit = await insertContent({
      externalId: extLocal,
      title: `ShardTesting Local ${TAG}`,
      description: "conținut de test pe primar",
      contentType: "video",
      provider: "f15-test",
      sourceType: "url",
      sourceUrl: "https://example.org/f15-local",
    });
    check("insert local reușit", Boolean(localHit), localHit ? `id local=${localHit.id}` : "");

    const mapRow = await shardMapLookup(extRemote);
    check("hartă de rutare scrisă (external_id → shard remote)", Boolean(mapRow), mapRow ? `shard=${mapRow.shard.name} remote_id=${mapRow.remoteId}` : "lipsă");
    const inShardDb = await shardDb.query(`SELECT id, title FROM content WHERE external_id = $1`, [extRemote]);
    check("rândul e REAL pe compute-ul remote (verificat direct în shard_b)", inShardDb.rows.length === 1);
    const notInPrimary = await q<{ id: number }>(`SELECT id FROM content WHERE external_id = $1`, [extRemote]);
    check("rândul remote NU e pe primar (plasament respectat)", notInPrimary.length === 0);

    // ===== TEST 3: dedup cross-shard =====
    console.log("\n TEST 3 — dedup cross-shard (re-insert)");
    const dup = await insertContent({
      externalId: extRemote,
      title: `ShardTesting Remote ${TAG} DUPLICAT`,
      description: "duplicat",
      contentType: "video",
      provider: "f15-test",
      sourceType: "url",
    });
    check("re-insert pe external_id existant → null (dedup cross-compute)", dup === null);

    // ===== TEST 4: scatter-gather căutare =====
    console.log("\n TEST 4 — căutare SCATTER-GATHER combinată din 2 shard-uri");
    invalidateSearchCache();
    const t0 = Date.now();
    const res = await searchLibrary("shardtesting", { limit: 20 });
    const dt = Date.now() - t0;
    check("rezultate din AMBELE shard-uri combinate", res.hits.length >= 2, `${res.hits.length} hit-uri din 2 shard-uri în ${dt}ms`);
    const hasLocal = res.hits.some((h) => h.externalId === extLocal);
    const hasRemote = res.hits.some((h) => h.externalId === extRemote);
    check("hit-ul local prezent", hasLocal);
    check("hit-ul remote prezent (venit prin scatter)", hasRemote);

    // ===== TEST 5: rezolvare ID cross-compute =====
    console.log("\n TEST 5 — rezolvare ID cross-compute (GET by id)");
    if (remoteHit) {
      const resolved = await shardMapByRemoteId(remoteHit.id);
      check("remote_id rezolvat din hartă", Boolean(resolved), resolved ? `→ ${resolved.shard.name}` : "");
      if (resolved) {
        const rows = await shardQuery(resolved.shard, `SELECT id, title FROM content WHERE id = $1`, [remoteHit.id]);
        check("rândul citit de pe compute-ul corect", rows.length === 1 && String(rows[0].title).includes(TAG));
      }
    } else {
      failed++;
      console.log("  ❌ TEST 5 imposibil (insert remote a eșuat)");
    }

    // ===== TEST 6: health probe pe toate shard-urile =====
    console.log("\n TEST 6 — health probe live");
    const probes = await probeAllShards();
    const upCount = probes.filter((p) => p.ok).length;
    check("toate shard-urile UP", upCount === probes.length, probes.map((p) => `${p.name}: ${p.pingMs}ms`).join(" • "));

    const st = await shardsStatus();
    check("capacitate agregată = sumă plafonuri", st.aggregateCeiling === 800_000_000, `2 × 400M = ${(st.aggregateCeiling / 1e6).toFixed(0)}M`);
  } finally {
    // ===== CLEANUP: platformă pristine + shard_b dezactivat =====
    console.log("\n CLEANUP");
    if (testIds.length > 0) {
      await q(`DELETE FROM content WHERE external_id = ANY($1::text[])`, [testIds]).catch(() => {});
      await q(`DELETE FROM content_shard_map WHERE external_id = ANY($1::text[])`, [testIds]).catch(() => {});
      await shardDb.query(`DELETE FROM content WHERE external_id = ANY($1::text[])`, [testIds]).catch(() => {});
      await shardDb.query(`DELETE FROM content WHERE external_id LIKE $1`, [`user:${TAG}%`]).catch(() => {});
    }
    await q(`DELETE FROM search_logs WHERE query LIKE 'shardtesting%' OR norm LIKE 'shardtesting%'`, []).catch(() => {});
    await q(`DELETE FROM search_stats WHERE norm LIKE 'shardtesting%'`, []).catch(() => {});
    await q(`DELETE FROM search_cache WHERE key LIKE 'sl:%' OR key LIKE 'sug:%' OR key LIKE 'trend:%'`, []).catch(() => {});
    // shard_b rămâne în registry DAR dezactivat (dovadă + re-activabil instant)
    await q(`UPDATE shards SET state = 'disabled' WHERE name = $1`, [SHARD_NAME]).catch(() => {});
    invalidateShardRegistry();
    console.log("  → conținut de test șters din ambele shard-uri");
    console.log("  → shard_b dezactivat în registry (re-activabil: op=update state=active)");
    await shardDb.end();
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`REZULTAT: ${passed} OK • ${failed} EȘEC`);
  console.log(`══════════════════════════════════════`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("EȘEC test sharding:", e);
    process.exitCode = 1;
  });
