import { NextRequest, NextResponse } from "next/server";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";
import {
  regionsStatus,
  probeAllRegions,
  regionFromRequest,
} from "@/lib/regions";

// ============================================================
// FAZA 16 — /api/regions: topologia MULTI-REGION (EU / US / APAC)
// GET ?probe=1 — listă regiuni + ping LIVE pe fiecare endpoint activ
//                (fără probe = ultimele valori cunoscute din registry)
// Răspunsul include și regiunea rezolvată pentru cererea curentă
// (demonstrație de geo-routing pe headerele edge / parametrul ?region=).
// ============================================================

export async function GET(req: NextRequest) {
  const rl = rateLimit(`regions:${clientIp(req)}`, { burst: 30, perMinute: 60 });
  if (!rl.ok) return tooMany(rl);

  try {
    const probe = req.nextUrl.searchParams.get("probe") === "1";
    const st = await regionsStatus();
    const probes = probe ? await probeAllRegions() : null;

    // geo-routing real pentru cererea curentă
    const resolvedRegion = regionFromRequest(
      req.headers.get("cf-ipcountry") || req.headers.get("x-vercel-ip-country"),
      req.nextUrl.searchParams.get("region")
    );

    return NextResponse.json({
      ok: true,
      regions: st.regions,
      active: st.active,
      total: st.total,
      configuredNote: st.configuredNote,
      probes,
      resolvedRegion,
      routing: "citirile de origin merg pe replică când DSN-ul regiunii e setat (qReadRegion); fallback transparent pe pool-ul RO",
      runbook:
        "Neon Console → Branch/Read replica pe regiunea dorită → copiază DSN-ul în env: NEON_REPLICA_URL (EU), NEON_REPLICA_US_URL (US), NEON_REPLICA_APAC_URL (APAC) → restart. Regiunea devine ACTIVE automat, zero schimbări de cod.",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
