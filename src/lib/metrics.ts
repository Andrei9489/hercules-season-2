// ============================================================
// Faza 17 — OBSERVABILITATE: registru metrics in-process,
// compatibil Prometheus (scrape /api/metrics).
//
// - CONTORI:   sv_http_requests_total{route,code,cache}
// - HISTOGRAMĂ: sv_http_request_duration_ms (bucket-uri cumulative
//               standard Prometheus + sum + count) per rută
// - GAUGE-URI: uptime, memorie RSS, breaker, admission gate,
//              fereastră glisantă 60s (rps, p50, p95, hit-rate edge)
//
// Registrul trăiește pe globalThis → supraviețuiește HMR și e
// partajat între toate modulele rutei în ACELAȘI proces (modelul
// instanței stateless: fiecare instanță își expune propriile metrics;
// Prometheus agrega la scrape — convenția standard).
//
// Fereastra glisantă e un inel bounded (5000 evenimente) — memorie
// maximă ~0,5 MB, fără scurgeri la trafic masiv.
// ============================================================

type CounterKey = string; // `${route}|${code}|${cache}`

type HistogramState = {
  buckets: Map<number, number>; // le → count cumulativ
  sum: number;
  count: number;
};

export const HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

type WindowEvent = { t: number; route: string; ms: number; code: number; cache: string };

import { breakerStatus, gateStatus } from "@/lib/circuit-breaker";

type MetricsState = {
  startedAt: number;
  counters: Map<CounterKey, number>;
  histograms: Map<string, HistogramState>; // key = route
  window: WindowEvent[]; // inel glisant 60s
};

const g = globalThis as unknown as { __svMetrics?: MetricsState };

function state(): MetricsState {
  if (!g.__svMetrics) {
    g.__svMetrics = {
      startedAt: Date.now(),
      counters: new Map(),
      histograms: new Map(),
      window: [],
    };
  }
  return g.__svMetrics;
}

function histFor(route: string): HistogramState {
  const s = state();
  let h = s.histograms.get(route);
  if (!h) {
    h = { buckets: new Map(HISTOGRAM_BUCKETS.map((b) => [b, 0])), sum: 0, count: 0 };
    s.histograms.set(route, h);
  }
  return h;
}

/** Înregistrează o cerere HTTP servită de această instanță. */
export function recordRequest(route: string, code: number, ms: number, cache: string): void {
  const s = state();
  const ck = `${route}|${code}|${cache}`;
  s.counters.set(ck, (s.counters.get(ck) || 0) + 1);

  const h = histFor(route);
  h.sum += ms;
  h.count += 1;
  for (const b of HISTOGRAM_BUCKETS) if (ms <= b) h.buckets.set(b, (h.buckets.get(b) || 0) + 1);

  s.window.push({ t: Date.now(), route, ms, code, cache });
  if (s.window.length > 5000) s.window.splice(0, s.window.length - 5000);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Snapshot JSON pentru /api/status și panoul UI (fereastră 60s). */
export function metricsSnapshot(windowSec = 60): {
  uptimeSec: number;
  windowSec: number;
  requests: number;
  rps: number;
  p50Ms: number;
  p95Ms: number;
  errorRatePct: number;
  edgeHitPct: number;
  topRoutes: { route: string; count: number; avgMs: number }[];
} {
  const s = state();
  const cutoff = Date.now() - windowSec * 1000;
  const w = s.window.filter((e) => e.t >= cutoff);

  const lat = w.map((e) => e.ms).sort((a, b) => a - b);
  const errors = w.filter((e) => e.code >= 500).length;
  const edgeHits = w.filter((e) => e.cache === "hit" || e.cache === "304").length;

  const byRoute = new Map<string, { count: number; totalMs: number }>();
  for (const e of w) {
    const r = byRoute.get(e.route) || { count: 0, totalMs: 0 };
    r.count += 1;
    r.totalMs += e.ms;
    byRoute.set(e.route, r);
  }
  const topRoutes = [...byRoute.entries()]
    .map(([route, r]) => ({ route, count: r.count, avgMs: Math.round(r.totalMs / r.count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    uptimeSec: Math.round((Date.now() - s.startedAt) / 1000),
    windowSec,
    requests: w.length,
    rps: Math.round((w.length / windowSec) * 100) / 100,
    p50Ms: percentile(lat, 50),
    p95Ms: percentile(lat, 95),
    errorRatePct: w.length ? Math.round((errors / w.length) * 10000) / 100 : 0,
    edgeHitPct: w.length ? Math.round((edgeHits / w.length) * 1000) / 10 : 0,
    topRoutes,
  };
}

/** Randare în format text Prometheus (exposition format standard). */
export function renderPrometheus(): string {
  const s = state();
  const lines: string[] = [];

  lines.push("# HELP sv_http_requests_total Total cereri HTTP per ruta/cod/stare-cache");
  lines.push("# TYPE sv_http_requests_total counter");
  for (const [key, n] of [...s.counters.entries()].sort()) {
    const [route, code, cache] = key.split("|");
    lines.push(
      `sv_http_requests_total{route="${route}",code="${code}",cache="${cache}"} ${n}`
    );
  }

  lines.push("# HELP sv_http_request_duration_ms Latenta cererilor (histograma Prometheus)");
  lines.push("# TYPE sv_http_request_duration_ms histogram");
  for (const [route, h] of [...s.histograms.entries()].sort()) {
    for (const b of HISTOGRAM_BUCKETS) {
      lines.push(`sv_http_request_duration_ms_bucket{route="${route}",le="${b}"} ${h.buckets.get(b) || 0}`);
    }
    lines.push(`sv_http_request_duration_ms_bucket{route="${route}",le="+Inf"} ${h.count}`);
    lines.push(`sv_http_request_duration_ms_sum{route="${route}"} ${Math.round(h.sum)}`);
    lines.push(`sv_http_request_duration_ms_count{route="${route}"} ${h.count}`);
  }

  const snap = metricsSnapshot(60);
  lines.push("# HELP sv_process_uptime_sec Secunde de la pornirea instantei");
  lines.push("# TYPE sv_process_uptime_sec gauge");
  lines.push(`sv_process_uptime_sec ${snap.uptimeSec}`);

  lines.push("# HELP sv_process_rss_bytes Memoria RSS a procesului");
  lines.push("# TYPE sv_process_rss_bytes gauge");
  lines.push(`sv_process_rss_bytes ${process.memoryUsage().rss}`);

  lines.push("# HELP sv_window_rps Cereri pe secunda in fereastra 60s (instanta curenta)");
  lines.push("# TYPE sv_window_rps gauge");
  lines.push(`sv_window_rps ${snap.rps}`);

  lines.push("# HELP sv_window_latency_ms Latenta p50/p95 in fereastra 60s");
  lines.push("# TYPE sv_window_latency_ms gauge");
  lines.push(`sv_window_latency_ms{quantile="0.50"} ${snap.p50Ms}`);
  lines.push(`sv_window_latency_ms{quantile="0.95"} ${snap.p95Ms}`);

  lines.push("# HELP sv_window_edge_hit_pct Procent cereri servite din cache edge/304 (60s)");
  lines.push("# TYPE sv_window_edge_hit_pct gauge");
  lines.push(`sv_window_edge_hit_pct ${snap.edgeHitPct}`);

  lines.push("# HELP sv_window_error_pct Procent erori 5xx in fereastra 60s");
  lines.push("# TYPE sv_window_error_pct gauge");
  lines.push(`sv_window_error_pct ${snap.errorRatePct}`);

  // Gauge-uri din straturile de reziliență (import static — fără cicluri)
  try {
    const b = breakerStatus();
    const gt = gateStatus();
    lines.push("# HELP sv_breaker_open Starea circuit breaker-ului (0 closed, 1 open/half-open)");
    lines.push("# TYPE sv_breaker_open gauge");
    lines.push(`sv_breaker_open ${b.state === "closed" ? 0 : 1}`);
    lines.push("# HELP sv_admission_inflight Cereri DB aflate acum in zbor");
    lines.push("# TYPE sv_admission_inflight gauge");
    lines.push(`sv_admission_inflight{waiting="${gt.waiting}"} ${gt.inFlight}`);
  } catch {
    // gauge-urile de reziliență lipsesc la scrape în contexte non-Node — acceptabil
  }

  lines.push("");
  return lines.join("\n");
}

/** Reset complet (folosit doar în teste). */
export function resetMetrics(): void {
  g.__svMetrics = {
    startedAt: Date.now(),
    counters: new Map(),
    histograms: new Map(),
    window: [],
  };
}
