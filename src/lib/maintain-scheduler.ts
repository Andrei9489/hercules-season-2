// ============================================================
// FAZA 13 — CRON INTERN DE MENTENANȚĂ
// Rulează runMaintenance("all") în interiorul procesului server la
// fiecare 6h (configurabil MAINTENANCE_INTERVAL_H), cu:
//   • pg_try_advisory_lock pe Neon → pe N instanțe, DOAR una rulează
//     (lock de sesiune: luat și eliberat pe ACEEAȘI conexiune dedicată)
//   • jurnal de rulări în tabelul maintain_log (creat idempotent)
//   • întârziere inițială la boot (nu concurează cu pornirea aplicației)
//   • fail-safe: orice eroare e logată, programarea continuă
// Pornit din src/instrumentation.ts (doar runtime Node.js).
// ============================================================
import { withRwClient, q } from "@/lib/pg";
import { runMaintenance } from "@/lib/maintain-core";

/** cheie advisory lock dedicată platformei (arbitrară, constantă) */
const LOCK_KEY = 918_273_645;

type G = typeof globalThis & {
  __svMaintainStarted?: boolean;
  __svMaintainLast?: { at: string; ok: boolean; skipped?: boolean; durationMs?: number };
};

const g = globalThis as G;

/** o rulare completă, protejată de advisory lock */
async function runLocked(trigger: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  return withRwClient(async (client) => {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    if (!lock.rows[0]?.ok) {
      return { skipped: true, reason: "altă instanță deține lock-ul de mentenanță" };
    }
    try {
      const report = await runMaintenance("all");
      const durationMs = Date.now() - started;
      g.__svMaintainLast = { at: new Date().toISOString(), ok: true, durationMs };

      // jurnal în Neon (best-effort — o eroare de log nu strică rularea)
      try {
        await q(
          `CREATE TABLE IF NOT EXISTS maintain_log (
             id bigserial PRIMARY KEY,
             at timestamptz NOT NULL DEFAULT now(),
             trigger text NOT NULL,
             ok boolean NOT NULL,
             duration_ms integer,
             report jsonb
           )`
        );
        await q(
          `INSERT INTO maintain_log (trigger, ok, duration_ms, report) VALUES ($1, $2, $3, $4)`,
          [trigger, true, durationMs, JSON.stringify(report)]
        );
      } catch (logErr) {
        console.error("[maintain] log neon eșuat:", (logErr as Error).message);
      }
      return { ...report, durationMs };
    } finally {
      // eliberare pe ACEEAȘI sesiune (obligatoriu pentru advisory lock)
      await client
        .query("SELECT pg_advisory_unlock($1)", [LOCK_KEY])
        .catch(() => {});
    }
  });
}

/** bucla unei rulări cu gestionarea erorilor (niciodată aruncată) */
async function safeRun(trigger: string): Promise<void> {
  const started = Date.now();
  try {
    const report = await runLocked(trigger);
    const skipped = Boolean((report as { skipped?: unknown }).skipped);
    if (!skipped) {
      g.__svMaintainLast = {
        at: new Date().toISOString(),
        ok: true,
        durationMs: Date.now() - started,
      };
    }
    console.log(
      `[maintain] ${trigger}: ${skipped ? "SKIP (lock deținut de altă instanță)" : "OK"} ` +
        `${JSON.stringify(report).slice(0, 400)}`
    );
  } catch (e) {
    g.__svMaintainLast = {
      at: new Date().toISOString(),
      ok: false,
      durationMs: Date.now() - started,
    };
    console.error(`[maintain] ${trigger} EȘUAT:`, (e as Error).message);
  }
}

/**
 * Pornește scheduler-ul (o singură dată per proces, idempotent la HMR).
 * Programare: prima rulare la 45s de la boot, apoi la fiecare 6h.
 */
export function startMaintainScheduler(): void {
  if (g.__svMaintainStarted) return;
  if (process.env.MAINTENANCE_ENABLED === "0") return;
  g.__svMaintainStarted = true;

  const intervalH = Math.max(1, Number(process.env.MAINTENANCE_INTERVAL_H) || 6);
  const intervalMs = intervalH * 3_600_000;
  const firstDelayMs = Math.max(5_000, Number(process.env.MAINTENANCE_FIRST_DELAY_MS) || 45_000);

  const bootTimer = setTimeout(() => {
    void safeRun("boot");
  }, firstDelayMs);
  bootTimer.unref?.();

  const intervalTimer = setInterval(() => {
    void safeRun("interval");
  }, intervalMs);
  intervalTimer.unref?.();

  console.log(
    `[maintain] scheduler pornit — prima rulare în ${Math.round(firstDelayMs / 1000)}s, apoi la fiecare ${intervalH}h (advisory lock activ)`
  );
}

/** ultima rulare cunoscută în acest proces (pentru /api/health extins) */
export function lastMaintainRun(): { at: string; ok: boolean; durationMs?: number } | null {
  return g.__svMaintainLast ?? null;
}
