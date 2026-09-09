// FAZA 17 — TEST INTEGRAL cu codul REAL din src/lib + HTTP real pe dev server:
//  • metrics registru: record → contori, histogramă, snapshot p50/p95, randare Prometheus
//  • HTTP: /api/metrics (text + json), headere edge pe cataloage, ETag/304 real
//  • /api/status: phase 17 + bloc faza17.live
// Idempotent, nu scrie nimic în Neon (observabilitatea e in-process).
import { resetMetrics, recordRequest, renderPrometheus, metricsSnapshot } from "../src/lib/metrics";

const BASE = process.env.BASE_URL || "http://localhost:3000";
let okCount = 0;
let failCount = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    okCount++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("FAZA 17 — TEST INTEGRAL\n");

  // ---------- 1. Registru metrics (cod real, in-process) ----------
  console.log("1. REGISTRU METRICS (src/lib/metrics.ts)");
  resetMetrics();
  recordRequest("test-route", 200, 42, "origin");
  recordRequest("test-route", 200, 120, "origin");
  recordRequest("test-route", 304, 8, "304");
  recordRequest("test-route", 500, 300, "error");
  const prom = renderPrometheus();
  ok("contor sv_http_requests_total", prom.includes('sv_http_requests_total{route="test-route",code="200",cache="origin"} 2'));
  ok("contor 304 separat", prom.includes('sv_http_requests_total{route="test-route",code="304",cache="304"} 1'));
  ok("histogramă sum/count", prom.includes('sv_http_request_duration_ms_sum{route="test-route"} 470') && prom.includes('sv_http_request_duration_ms_count{route="test-route"} 4'));
  ok("bucket +Inf = count", prom.includes('sv_http_request_duration_ms_bucket{route="test-route",le="+Inf"} 4'));
  ok("gauge-uri prezente", prom.includes("sv_process_uptime_sec") && prom.includes("sv_window_rps") && prom.includes("sv_breaker_open"));
  const snap = metricsSnapshot(60);
  ok("snapshot requests=4", snap.requests === 4, `requests=${snap.requests}`);
  ok("snapshot p50 plauzibil", snap.p50Ms >= 42 && snap.p50Ms <= 120, `p50=${snap.p50Ms}ms`);
  ok("snapshot errorRate 25%", snap.errorRatePct === 25, `${snap.errorRatePct}%`);
  ok("snapshot edgeHit 25% (1×304)", snap.edgeHitPct === 25, `${snap.edgeHitPct}%`);
  ok("topRoutes conține ruta de test", snap.topRoutes.some((r) => r.route === "test-route"));

  // gauge-uri din reziliență (breaker/gate) — se randează fără erori
  ok("gauge admission", prom.includes("sv_admission_inflight"));

  // ---------- 2. HTTP real: /api/metrics ----------
  console.log("\n2. ENDPOINT /api/metrics (HTTP real)");
  const mres = await fetch(`${BASE}/api/metrics`);
  ok("200 text/plain", mres.status === 200 && (mres.headers.get("content-type") || "").includes("text/plain"));
  const mtext = await mres.text();
  ok("format Prometheus (HELP/TYPE)", mtext.includes("# HELP") && mtext.includes("# TYPE"));
  ok("s-a înregistrat traficul dev real", mtext.includes('route="tmdb"') || mtext.includes('route="browse"') || mtext.includes('route="status"'));
  const jres = await fetch(`${BASE}/api/metrics?format=json`);
  const j = (await jres.json()) as { requests: number; uptimeSec: number };
  ok("varianta JSON funcțională", jres.status === 200 && typeof j.requests === "number" && j.uptimeSec > 0, `requests=${j.requests}, uptime=${j.uptimeSec}s`);

  // ---------- 3. Edge cache pe cataloage + ETag/304 REAL ----------
  console.log("\n3. EDGE CACHE CATALOAGE (HTTP real)");
  const t0 = Date.now();
  const r1 = await fetch(`${BASE}/api/tmdb?brand=netflix`);
  const cc = r1.headers.get("cache-control") || "";
  const etag = r1.headers.get("etag") || "";
  ok("tmdb 200 + s-maxage", r1.status === 200 && cc.includes("s-maxage=300"), `${r1.status}, ${cc}`);
  ok("tmdb + SWR + ETag", cc.includes("stale-while-revalidate=600") && etag.startsWith('W/"'));
  const r2 = await fetch(`${BASE}/api/tmdb?brand=netflix`, { headers: { "If-None-Match": etag } });
  ok("304 Not Modified la repeat", r2.status === 304, `${r2.status} (după ${Date.now() - t0}ms total)`);
  const body304 = r2.status === 304 ? "" : await r2.text();
  ok("304 = zero corp (bandwidth 0)", body304.length === 0);

  const rS = await fetch(`${BASE}/api/search?q=${encodeURIComponent("test")}`);
  const ccS = rS.headers.get("cache-control") || "";
  ok("search mode=library cdn-ready", rS.status === 200 && ccS.includes("s-maxage=30"), ccS);

  // rute fierbinți instrumentate (contorizate în metrics)
  await fetch(`${BASE}/api/browse?tab=all`);
  await fetch(`${BASE}/api/status`);
  const m2 = await fetch(`${BASE}/api/metrics`).then((r) => r.text());
  ok("browse instrumentat", m2.includes('route="browse"'));
  ok("status instrumentat", m2.includes('route="status"'));
  ok("search instrumentat", m2.includes('route="search"'));
  ok("tmdb instrumentat (200+304)", m2.includes('route="tmdb",code="200"') && m2.includes('route="tmdb",code="304"'));

  // ---------- 4. /api/status phase 17 ----------
  console.log("\n4. /api/status FAZA 17");
  const st = await fetch(`${BASE}/api/status`).then((r) => r.json()) as {
    resilience: { phase: number };
    faza17?: { edgeOffload?: { catalogRoutes: number }; observability?: { endpoint: string }; live?: { requests: number } };
  };
  ok("phase = 17", st.resilience?.phase === 17, `phase=${st.resilience?.phase}`);
  ok("bloc faza17.edgeOffload", st.faza17?.edgeOffload?.catalogRoutes === 10);
  ok("bloc faza17.observability", (st.faza17?.observability?.endpoint || "").includes("/api/metrics"));
  ok("faza17.live prezent", typeof st.faza17?.live?.requests === "number");

  // ---------- Rezultat ----------
  console.log(`\n=== REZULTAT: ${okCount} OK / ${failCount} EȘEC ===`);
  if (failCount > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error("EȘEC FATAL:", e);
  process.exit(1);
});
