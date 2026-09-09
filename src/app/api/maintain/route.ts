import { NextRequest, NextResponse } from "next/server";
import { runMaintenance, type MaintainOp } from "@/lib/maintain-core";

// ============================================================
// FAZA 11 → 13 — MENTENANȚĂ AUTOMATĂ
// Nucleul a fost mutat în src/lib/maintain-core.ts (Faza 13) pentru a
// putea fi rulat și de cron-ul INTERN (instrumentation → scheduler, la
// fiecare 6h, cu advisory lock Neon — fără auto-apel HTTP).
// Acest route rămâne pentru declanșare manuală/externă (cron dedicat,
// tooling de ops), protejat prin token (header x-maintain-token).
// ============================================================

const TOKEN = process.env.MAINTENANCE_TOKEN || "sv11-maintain-Kq9w2Rm8Tb5Xz1Lp";

function authorized(req: NextRequest): boolean {
  return (req.headers.get("x-maintain-token") || "") === TOKEN;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Token mentenanță invalid" }, { status: 401 });
  }

  const op = (req.nextUrl.searchParams.get("op") || "all") as MaintainOp;
  try {
    const report = await runMaintenance(op);
    return NextResponse.json(report);
  } catch (e) {
    console.error("Maintain error:", e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message, op },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  // GET = doar stats (pentru monitorizare), protejat la fel
  if (!authorized(req)) {
    return NextResponse.json({ error: "Token mentenanță invalid" }, { status: 401 });
  }
  const report = await runMaintenance("stats");
  return NextResponse.json({ ok: true, stats: report.stats });
}
