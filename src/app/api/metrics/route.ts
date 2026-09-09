// ============================================================
// Faza 17 — /api/metrics: endpoint de scrape Prometheus.
//
// FORMAT: text/plain; version=0.0.4 (exposition format standard) —
// Prometheus/Grafana Cloud/Vector/Datadog îl consumă direct.
//
// SECURITATE: dacă env METRICS_TOKEN e setat, scrape-ul cere
// `Authorization: Bearer <token>` sau `?token=`. Fără token setat
// (dev/sandbox) endpoint-ul e deschis — metrics nu expune date
// utilizatori, doar agregate de performanță ale instanței.
//
// Fiecare instanță din cluster își expune propriile metrics;
// Prometheus scrape-ui toate și agrega (convenția standard).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { renderPrometheus, metricsSnapshot } from "@/lib/metrics";
import { renderClusterGauges } from "@/lib/cluster-control";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const auth = req.headers.get("authorization") || "";
    const q = req.nextUrl.searchParams.get("token") || "";
    if (auth !== `Bearer ${token}` && q !== token) {
      return NextResponse.json(
        { error: "token metrics lipsă sau invalid" },
        { status: 401 }
      );
    }
  }

  const fmt = req.nextUrl.searchParams.get("format");
  if (fmt === "json") {
    // varianta JSON pentru panoul UI (aceleași date, consum programatic)
    return NextResponse.json(metricsSnapshot(60), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // FAZA 19a — gauge-uri cluster (sv_cluster_*) alipite expunerii locale;
  // sunt citite din cache-ul heartbeat-ului → zero DB la scrape.
  return new NextResponse(renderPrometheus() + renderClusterGauges(), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
