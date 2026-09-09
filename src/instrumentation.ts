/**
 * FAZA 13 — Instrumentation Next.js (hook de boot al serverului).
 * Pornește cron-ul intern de mentenanță DOAR în runtime-ul Node.js
 * (nu în Edge și nu în faza de build/prerender).
 * Idempotent: startMaintainScheduler() se protejează singur la HMR.
 *
 * FAZA 19a — pornește și heartbeat-ul de cluster: fiecare instanță se
 * publică în cluster_nodes (Neon) la fiecare 3s → vedere globală reală
 * (inflight/rps/instanțe vii) pentru status, metrics și panoul UI.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startMaintainScheduler } = await import("@/lib/maintain-scheduler");
  startMaintainScheduler();
  const { startClusterHeartbeat, ensureClusterSchema } = await import("@/lib/cluster-control");
  await ensureClusterSchema().catch(() => {});
  startClusterHeartbeat(3_000);
}
