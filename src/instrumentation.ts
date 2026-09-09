/**
 * FAZA 13 — Instrumentation Next.js (hook de boot al serverului).
 * Pornește cron-ul intern de mentenanță DOAR în runtime-ul Node.js
 * (nu în Edge și nu în faza de build/prerender).
 * Idempotent: startMaintainScheduler() se protejează singur la HMR.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startMaintainScheduler } = await import("@/lib/maintain-scheduler");
  startMaintainScheduler();
}
