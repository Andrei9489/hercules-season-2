// ============================================================
// FAZA 20a — STRES TEST REAL 10.000 SIMULTANE PRIN LOAD BALANCER
// ============================================================
// Diferențe față de Faza 19: traficul intră prin LB (round-robin
// pe N instanțe standalone de producție), iar contorii server-side
// sunt SUMA metrics-ului fiecărei instanțe (în cluster fiecare
// instanță contorizează local — convenție Prometheus).
// Rezultate: scripts/stress-results-f20.json
// Rulează: bun scripts/stress-search-f20.ts   (LB pe :3210)
// ============================================================
import { q } from "../src/lib/pg";

const BASE = process.env.BENCH_BASE || "http://localhost:3210";
const INSTANCE_PORTS = (process.env.INSTANCE_PORTS || "3101,3102,3103,3104,3105,3106")
  .split(",").map(Number).filter(Boolean);
const REQ_TIMEOUT_MS = 20_000;

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

type ServerCounters = {
  searchTotal: number; search429: number; search5xx: number;
  histCount: number; histSumMs: number;
};

/** Suma contorilor pe TOATE instanțele (metrics local per instanță). */
async function readServerCounters(): Promise<ServerCounters> {
  const c: ServerCounters = { searchTotal: 0, search429: 0, search5xx: 0, histCount: 0, histSumMs: 0 };
  const texts = await Promise.all(
    INSTANCE_PORTS.map((p) =>
      fetch(`http://127.0.0.1:${p}/api/metrics`, { cache: "no-store" })
        .then((r) => r.text())
        .catch(() => "")
    )
  );
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (line.startsWith("sv_http_requests_total{")) {
        const route = /route="([^"]+)"/.exec(line)?.[1];
        const code = /code="([^"]+)"/.exec(line)?.[1];
        if (route === "search") {
          const v = Number(line.split(" ").pop()) || 0;
          c.searchTotal += v;
          if (code === "429") c.search429 += v;
          if (code && code.startsWith("5")) c.search5xx += v;
        }
      }
      if (line.startsWith('sv_http_request_duration_ms_sum{route="search"}'))
        c.histSumMs += Number(line.split(" ").pop()) || 0;
      if (line.startsWith('sv_http_request_duration_ms_count{route="search"}'))
        c.histCount += Number(line.split(" ").pop()) || 0;
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

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

type StageResult = {
  targetConcurrency: number;
  durationSec: number;
  completed: number;
  rps: number;
  p50Ms: number; p95Ms: number; p99Ms: number;
  maxInflight: number;
  timeouts: number;
  errorsByKind: Record<string, number>;
  server: { searchDelta: number; rps429: number; rps5xx: number; meanServerMs: number };
  cluster: { alive: number; globalInflight: number; globalRps: number };
};

async function runStage(target: number, seconds: number): Promise<StageResult> {
  console.log(`\n▶ treaptă ${target.toLocaleString("ro-RO")} concurenți prin LB, ${seconds}s…`);
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
  const dTotal = after.searchTotal - before.searchTotal;
  const d429 = after.search429 - before.search429;
  const d5xx = after.search5xx - before.search5xx;
  const dHistCount = after.histCount - before.histCount;
  const dHistSum = after.histSumMs - before.histSumMs;
  const meanServerMs = dHistCount > 0 ? Math.round(dHistSum / dHistCount) : 0;
  const rps = Math.round((completed / seconds) * 100) / 100;

  const result: StageResult = {
    targetConcurrency: target,
    durationSec: seconds,
    completed,
    rps,
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    p99Ms: Math.round(percentile(sorted, 99)),
    maxInflight,
    timeouts,
    errorsByKind,
    server: {
      searchDelta: dTotal,
      rps429: Math.round((d429 / seconds) * 100) / 100,
      rps5xx: Math.round((d5xx / seconds) * 100) / 100,
      meanServerMs,
    },
    cluster,
  };
  console.log(
    `  ✓ ${completed.toLocaleString("ro-RO")} cereri • ${rps} rps • P50 ${result.p50Ms}ms • P95 ${result.p95Ms}ms • P99 ${result.p99Ms}ms • max inflight ${maxInflight} • 429/s ${(d429 / seconds).toFixed(1)} • 5xx/s ${(d5xx / seconds).toFixed(1)} • timeout ${timeouts} • cluster ${cluster.alive} instanțe vii, inflight global ${cluster.globalInflight}`
  );
  return result;
}

async function setPool(capacity: number, refillPerSec: number): Promise<void> {
  await q(
    `INSERT INTO cluster_rate_pool (key, capacity, tokens, refill_per_sec)
     VALUES ('search', $1, $1, $2)
     ON CONFLICT (key) DO UPDATE SET
       capacity = EXCLUDED.capacity,
       refill_per_sec = EXCLUDED.refill_per_sec,
       tokens = LEAST(EXCLUDED.capacity, cluster_rate_pool.tokens + 2000),
       updated_at = now()`,
    [capacity, refillPerSec]
  );
  console.log(`  [ops] rezerva globală „search" = ${capacity} tok @ ${refillPerSec}/s — LIVE prin SQL`);
}

async function main(): Promise<void> {
  console.log(`STRES TEST REAL PRIN LB — țintă 10.000 simultane • ${BASE} • instanțe ${INSTANCE_PORTS.join(",")}`);
  const results: StageResult[] = [];

  // FAZA A — capacitate brută (rezervă extinsă operațional, protecția nu maschează fizica)
  await setPool(200_000, 60_000);
  results.push(await runStage(250, 12));
  results.push(await runStage(1_000, 12));
  results.push(await runStage(2_500, 12));
  results.push(await runStage(5_000, 12));
  results.push(await runStage(10_000, 15));

  // FAZA B — presetarea de producție activă (4.000 @ 1.500)
  await setPool(4_000, 1_500);
  results.push(await runStage(5_000, 12));
  results.push(await runStage(10_000, 15));

  // restaurare
  await setPool(4_000, 1_500);

  const aMax = results.reduce((m, r) => Math.max(m, r.rps), 0);
  const aLast = results.filter((r) => r.targetConcurrency === 10_000)[0];
  const perInstance = Math.round(aMax / INSTANCE_PORTS.length);
  const f19Peak = 315.75;

  const summary = {
    at: new Date().toISOString(),
    base: BASE,
    instances: INSTANCE_PORTS,
    method: "HTTP real prin LB (round-robin), buclă închisă, IP-uri virtuale, zero mock; contori = suma metrics per instanță",
    stages: results,
    verdict: {
      peakClusterRps: aMax,
      peakPerInstanceRps: perInstance,
      f19SingleInstancePeak: f19Peak,
      speedupVsSingle: Math.round((aMax / f19Peak) * 100) / 100,
      at10k: aLast ? `${aLast.rps} rps • P95 ${aLast.p95Ms}ms • timeout ${aLast.timeouts} • erori ${JSON.stringify(aLast.errorsByKind)}` : "",
      mathFor10k: `cu ${perInstance} rps/instanță măsurată în cluster → 10.000 simultane la P95 ≤2s ≈ ${Math.ceil(10_000 / Math.max(1, Math.round((f19Peak + perInstance) / 2) * 2))} instanțe (estimare conservatoare interpolată); cu edge offload 85% bugetul origin 1.500 r/s → ${Math.ceil(1_500 / Math.max(1, perInstance))} instanțe + CDN`,
    },
  };
  const { writeFileSync } = await import("fs");
  writeFileSync("scripts/stress-results-f20.json", JSON.stringify(summary, null, 2));
  console.log("\n════════ VERDICT FAZA 20a (cluster prin LB) ════════");
  console.log(`vârf cluster (${INSTANCE_PORTS.length} instanțe): ${aMax} rps căutări`);
  console.log(`per instanță: ${perInstance} rps • speedup vs instanță unică Faza 19 (${f19Peak} rps): ${summary.verdict.speedupVsSingle}x`);
  console.log(`10k: ${summary.verdict.at10k}`);
  console.log(summary.verdict.mathFor10k);
  console.log("rezultate: scripts/stress-results-f20.json");
  process.exit(0);
}

await main();
