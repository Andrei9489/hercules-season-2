// ============================================================
// FAZA 19b — STRES TEST REAL: 10.000 CĂUTĂRI SIMULTANE
// ============================================================
// Zero mock: fiecare cerere e HTTP real împotriva serverului LIVE
// (localhost:3000), cu utilizatori virtuali distincți (IP propriu),
// buclă închisă (fiecare worker ține exact 1 cerere în zbor →
// concurența reală = numărul de workeri).
//
// DOUĂ FAZE, ambele reale:
//   FAZA A — CAPACITATE BRUTĂ: rezerva globală search e extinsă
//            OPERAȚIONAL prin SQL direct în Neon (UPDATE pe
//            cluster_rate_pool — levier real de ops, fără restart),
//            ca limiter-ul global să nu mascăm capacitatea fizică.
//   FAZA B — PROTECȚIE ACTIVĂ: rezerva revine la presetarea de
//            producție (4.000 tok, refil 1.500/s) → vedem COMPORTAMENTUL
//            REAL de protecție la supraîncărcare (429 controlat).
//
// Per treaptă măsurăm: rps, p50/p95/p99, erori (după fel), inflight
// real mediu/max, DELTA contorilor server-side din /api/metrics
// (total search origin, 429, 5xx, latență medie server) și vederea
// de cluster din /api/status (instanțe vii, inflight global).
//
// Rezultate: scripts/stress-results-f19.json (graficul PNG e generat
// separat de scripts/stress-chart-f19.py).
// Rulează: bun scripts/stress-search-f19.ts
// ============================================================
import { q } from "../src/lib/pg";

const BASE = process.env.BENCH_BASE || "http://localhost:3000";
const REQ_TIMEOUT_MS = 20_000;

// mix realist de căutări (aceleași distribuții ca bench-users):
const QUERIES = ["a", "the", "news", "kiss", "radio", "film", "adele", "tv", "sun", "rom", "live", "music"];
const SUGGESTS = ["a", "ab", "ad", "n", "ne", "k", "ki", "s", "st", "r"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function nextSearchPath(): string {
  const r = Math.random();
  if (r < 0.65) return `/api/search?mode=library&q=${encodeURIComponent(pick(QUERIES) + pick(["", "a", "o"]))}&limit=24`;
  if (r < 0.9) return `/api/search?mode=suggest&q=${encodeURIComponent(pick(SUGGESTS))}`;
  return `/api/search?mode=full&q=${encodeURIComponent(pick(QUERIES))}&limit=24`;
}

// ---------- citirea contorilor server-side (text Prometheus) ----------
type ServerCounters = {
  searchTotal: number;
  search429: number;
  search5xx: number;
  search304: number;
  histCount: number;
  histSumMs: number;
};

async function readServerCounters(): Promise<ServerCounters> {
  const res = await fetch(`${BASE}/api/metrics`, { cache: "no-store" });
  const text = await res.text();
  const c: ServerCounters = { searchTotal: 0, search429: 0, search5xx: 0, search304: 0, histCount: 0, histSumMs: 0 };
  for (const line of text.split("\n")) {
    if (line.startsWith("sv_http_requests_total{")) {
      const route = /route="([^"]+)"/.exec(line)?.[1];
      const code = /code="([^"]+)"/.exec(line)?.[1];
      if (route === "search") {
        const v = Number(line.split(" ").pop()) || 0;
        c.searchTotal += v;
        if (code === "429") c.search429 += v;
        if (code === "304") c.search304 += v;
        if (code && code.startsWith("5")) c.search5xx += v;
      }
    }
    if (line.startsWith('sv_http_request_duration_ms_sum{route="search"}')) {
      c.histSumMs = Number(line.split(" ").pop()) || 0;
    }
    if (line.startsWith('sv_http_request_duration_ms_count{route="search"}')) {
      c.histCount = Number(line.split(" ").pop()) || 0;
    }
  }
  return c;
}

async function readClusterView(): Promise<{ alive: number; globalInflight: number; globalRps: number }> {
  try {
    const res = await fetch(`${BASE}/api/status`, { cache: "no-store" });
    const j = (await res.json()) as {
      faza19?: { clusterControl?: { view?: { alive: number; globalInflight: number; globalRps: number } } };
    };
    const v = j.faza19?.clusterControl?.view;
    return { alive: v?.alive ?? 0, globalInflight: v?.globalInflight ?? 0, globalRps: v?.globalRps ?? 0 };
  } catch {
    return { alive: 0, globalInflight: 0, globalRps: 0 };
  }
}

// ---------- o treaptă de stres ----------
export type StageResult = {
  phase: "A-brut" | "B-protecție";
  targetConcurrency: number;
  durationSec: number;
  completed: number;
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxInflight: number;
  avgInflight: number;
  timeouts: number;
  errorsByKind: Record<string, number>;
  server: { searchDelta: number; rps429: number; rps5xx: number; meanServerMs: number };
  cluster: { alive: number; globalInflight: number; globalRps: number };
  verdict: string;
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runStage(
  phase: "A-brut" | "B-protecție",
  target: number,
  seconds: number
): Promise<StageResult> {
  console.log(`\n▶ [${phase}] treaptă ${target.toLocaleString("ro-RO")} concurenți, ${seconds}s…`);
  const before = await readServerCounters();
  const deadline = Date.now() + seconds * 1000;
  const latencies: number[] = [];
  const errorsByKind: Record<string, number> = {};
  let completed = 0;
  let timeouts = 0;
  let inflight = 0;
  let maxInflight = 0;
  let inflightSum = 0;
  let inflightSamples = 0;

  const sampler = setInterval(() => {
    inflightSum += inflight;
    inflightSamples++;
    if (inflight > maxInflight) maxInflight = inflight;
  }, 100);
  sampler.unref?.();

  const worker = async (wid: number): Promise<void> => {
    const userIp = `10.${(wid >> 16) & 255}.${(wid >> 8) & 255}.${wid & 255 || 1}`;
    while (Date.now() < deadline) {
      inflight++;
      if (inflight > maxInflight) maxInflight = inflight;
      const t = performance.now();
      try {
        const res = await fetch(BASE + nextSearchPath(), {
          cache: "no-store",
          headers: { "x-forwarded-for": userIp },
          signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
        });
        await res.arrayBuffer();
        const ms = performance.now() - t;
        latencies.push(ms);
        completed++;
        if (res.status >= 400) {
          const k = `${res.status}`;
          errorsByKind[k] = (errorsByKind[k] || 0) + 1;
        }
      } catch (e) {
        const msg = String((e as { name?: string; message?: string })?.name || e);
        timeouts += msg === "TimeoutError" ? 1 : 0;
        const k = msg === "TimeoutError" ? "timeout" : "network";
        errorsByKind[k] = (errorsByKind[k] || 0) + 1;
      } finally {
        inflight--;
      }
    }
  };

  await Promise.all(Array.from({ length: target }, (_, i) => worker(i)));
  clearInterval(sampler);

  const after = await readServerCounters();
  const cluster = await readClusterView();
  const sorted = [...latencies].sort((a, b) => a - b);
  const dur = seconds;
  const dTotal = after.searchTotal - before.searchTotal;
  const d429 = after.search429 - before.search429;
  const d5xx = after.search5xx - before.search5xx;
  const dHistCount = after.histCount - before.histCount;
  const dHistSum = after.histSumMs - before.histSumMs;
  const meanServerMs = dHistCount > 0 ? Math.round(dHistSum / dHistCount) : 0;

  const rps = Math.round((completed / dur) * 100) / 100;
  const verdict =
    d429 / Math.max(1, dTotal) > 0.3
      ? "protecție globală activă — origin scutit (429 controlat), scalează cu instanțe"
      : timeouts > completed * 0.05
        ? "saturație fizică a instanței unice — necesare instanțe suplimentare pentru această treaptă"
        : rps >= target * 0.5
          ? "ABSORTĂ — instanța a servit treapta fără degradare semnificativă"
          : "subiectiv sub capacitate nominală — coadă vizibilă, dar fără erori masive";

  const result: StageResult = {
    phase,
    targetConcurrency: target,
    durationSec: dur,
    completed,
    rps,
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    p99Ms: Math.round(percentile(sorted, 99)),
    maxInflight,
    avgInflight: inflightSamples ? Math.round(inflightSum / inflightSamples) : 0,
    timeouts,
    errorsByKind,
    server: {
      searchDelta: dTotal,
      rps429: Math.round((d429 / dur) * 100) / 100,
      rps5xx: Math.round((d5xx / dur) * 100) / 100,
      meanServerMs,
    },
    cluster,
    verdict,
  };
  console.log(
    `  ✓ ${completed.toLocaleString("ro-RO")} cereri • ${rps} rps • P50 ${result.p50Ms}ms • P95 ${result.p95Ms}ms • P99 ${result.p99Ms}ms • max inflight ${maxInflight} • 429 server ${(d429 / dur).toFixed(1)}/s • 5xx ${(d5xx / dur).toFixed(1)}/s • timeout ${timeouts}`
  );
  return result;
}

async function setPool(capacity: number, refillPerSec: number, leaseSize: number): Promise<void> {
  // prin stratul real pg.ts (aceeași sursă de adevăr DSN ca serverul)
  await q(
    `INSERT INTO cluster_rate_pool (key, capacity, tokens, refill_per_sec)
     VALUES ('search', $1, $1, $2)
     ON CONFLICT (key) DO UPDATE SET
       capacity = EXCLUDED.capacity,
       refill_per_sec = EXCLUDED.refill_per_sec,
       tokens = LEAST(EXCLUDED.capacity, cluster_rate_pool.tokens + 1000),
       updated_at = now()`,
    [capacity, refillPerSec]
  );
  console.log(`  [ops] rezerva globală „search" = ${capacity} tok @ ${refillPerSec}/s (lease ${leaseSize}) — setată LIVE prin SQL, fără restart`);
}

async function main(): Promise<void> {
  console.log(`STRES TEST REAL — căutări simultane, țintă 10.000 • ${BASE}`);
  console.log(`faza A = capacitate brută (rezervă extinsă operațional) • faza B = protecție activă (presetare producție)`);

  const results: StageResult[] = [];

  // ---------- FAZA A — capacitate brută ----------
  await setPool(200_000, 60_000, 250);
  results.push(await runStage("A-brut", 250, 12));
  results.push(await runStage("A-brut", 1_000, 12));
  results.push(await runStage("A-brut", 2_500, 12));
  results.push(await runStage("A-brut", 5_000, 12));
  results.push(await runStage("A-brut", 10_000, 15));

  // ---------- FAZA B — protecție activă (presetare producție) ----------
  await setPool(4_000, 1_500, 250);
  results.push(await runStage("B-protecție", 1_000, 12));
  results.push(await runStage("B-protecție", 2_500, 12));
  results.push(await runStage("B-protecție", 5_000, 12));
  results.push(await runStage("B-protecție", 10_000, 15));

  // ---------- restaurare presetare producție (idempotent) ----------
  await setPool(4_000, 1_500, 250);

  // ---------- verdict final ----------
  const aMax = results.filter((r) => r.phase === "A-brut").reduce((m, r) => Math.max(m, r.rps), 0);
  const aLast = results.filter((r) => r.phase === "A-brut").pop();
  const bLast = results.filter((r) => r.phase === "B-protecție").pop();
  const summary = {
    at: new Date().toISOString(),
    base: BASE,
    method: "HTTP real, buclă închisă, IP-uri virtuale distincte, zero mock",
    stages: results,
    verdict: {
      peakSingleInstanceRps: aMax,
      brutAt10k: aLast ? `${aLast.rps} rps • P95 ${aLast.p95Ms}ms • timeout ${aLast.timeouts} • erori ${JSON.stringify(aLast.errorsByKind)}` : "",
      protectieAt10k: bLast ? `${bLast.rps} rps • 429 server ${bLast.server.rps429}/s • P95 ${bLast.p95Ms}ms • timeout ${bLast.timeouts}` : "",
      conclusion:
        `Capacitate brută măsurată: ${aMax} rps căutări/origin pe INSTANȚA UNICĂ de dev. ` +
        `Pentru 10.000 căutări simultane: la P50 ~${aLast?.p50Ms ?? 0}ms/căutare, 10.000 în zbor ≈ 10.000/P95_s → ` +
        `cu ${aMax} rps/instanță ≈ ${Math.ceil(10_000 / Math.max(1, aMax))} instanțe (LB Faza 15 deja suportă N instanțe; ` +
        `cu edge offload 85% din Faza 17, bugetul origin cluster 1.500 r/s = ${Math.ceil((10_000 * 0.15) / Math.max(1, aMax / 10))} instanțe).`,
    },
  };
  const { writeFileSync } = await import("fs");
  writeFileSync("scripts/stress-results-f19.json", JSON.stringify(summary, null, 2));
  console.log("\n════════ VERDICT ════════");
  console.log(`vârf instanță unică: ${aMax} rps căutări`);
  console.log(`10k brut:  ${summary.verdict.brutAt10k}`);
  console.log(`10k protecție: ${summary.verdict.protectieAt10k}`);
  console.log(summary.verdict.conclusion);
  console.log("rezultate: scripts/stress-results-f19.json");
  process.exit(0);
}

await main();
