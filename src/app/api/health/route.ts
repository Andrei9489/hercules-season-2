import { NextResponse } from "next/server";
import { q, qRead, replicaEnabled } from "@/lib/pg";
import { breakerStatus, gateStatus } from "@/lib/circuit-breaker";

// ============================================================
// /api/health (Faza 9) — health-check rapid pentru monitorizare
// și pentru load-balancer (failover): ping DB cu timeout scurt +
// starea circuit breaker-ului și a admission control.
// Faza 12: PROBĂ READ-REPLICA — când NEON_REPLICA_URL e configurat,
// pool-ul RO (prin care trec toate citirile: căutare, sugestii,
// listări) e sondat separat de pool-ul RW (primar), iarhealth-ul
// raportează ambele brațe pentru failover granular.
// ============================================================

async function timed(fn: () => Promise<unknown>): Promise<{ ms: number; err?: string }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ms: Date.now() - t0 };
  } catch (e) {
    return { ms: Date.now() - t0, err: String((e as { message?: string })?.message || e).slice(0, 160) };
  }
}

export async function GET() {
  const t0 = Date.now();
  const hasReplica = replicaEnabled();

  // Citirea principală (RO pool → replică când e configurată, altfel primar)
  const read = await timed(() => qRead(`SELECT 1 AS ok`));

  let primary: { ms: number; err?: string } | null = null;
  if (hasReplica) {
    // Cu replică activă, sondăm și primarul (RW pool) separat
    primary = await timed(() => q(`SELECT 1 AS ok`));
  }

  const readUp = !read.err;
  const primaryUp = primary ? !primary.err : readUp; // fără replică, RO=R/W
  const ok = primaryUp; // primarul e critic; replica doar degradează citirile

  return NextResponse.json(
    {
      ok,
      db: primaryUp ? "up" : "down",
      dbPingMs: read.ms,
      replica: {
        enabled: hasReplica,
        state: hasReplica ? (readUp ? "up" : "down") : "not-configured",
        readPingMs: read.ms,
        primaryPingMs: primary ? primary.ms : null,
        note: hasReplica
          ? "NEON_REPLICA_URL activ — citirile merg pe replică, scrierile pe primar; failover granular per braț"
          : "fără NEON_REPLICA_URL: pool RO izolează citirile de scrieri pe primar (replica-ready)",
      },
      breaker: breakerStatus(),
      gate: gateStatus(),
      at: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 }
  );
}
