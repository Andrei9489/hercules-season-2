import { NextResponse } from "next/server";
import { qRead } from "@/lib/pg";
import { breakerStatus, gateStatus } from "@/lib/circuit-breaker";

// ============================================================
// /api/health (Faza 9) — health-check rapid pentru monitorizare
// și pentru load-balancer (failover): ping DB cu timeout scurt +
// starea circuit breaker-ului și a admission control.
// ============================================================

export async function GET() {
  const t0 = Date.now();
  try {
    await qRead(`SELECT 1 AS ok`);
    return NextResponse.json({
      ok: true,
      db: "up",
      dbPingMs: Date.now() - t0,
      breaker: breakerStatus(),
      gate: gateStatus(),
      at: new Date().toISOString(),
    });
  } catch (e) {
    // DB picat/lent → 503 clar pentru failover, dar cu starea raportată
    return NextResponse.json(
      {
        ok: false,
        db: "down",
        dbPingMs: Date.now() - t0,
        breaker: breakerStatus(),
        gate: gateStatus(),
        error: String((e as { message?: string })?.message || e).slice(0, 200),
        at: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
