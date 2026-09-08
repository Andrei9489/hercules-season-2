// ============================================================
// FAZA 13 — MENTENANȚĂ: nucleu partajat (route + scheduler intern)
// Operațiuni (idempotente, sigure la rulare repetată):
//   • ensure_partitions — partiții search_logs pentru anii curent..+3
//   • cleanup_cache     — rândurile expirate din search_cache (L2 distribuit)
//   • refresh_rollup    — re-materializează bucket-ele de sugestii 1-3
//   • stats             — raport de sănătate (partiții, cache, dimensiune DB)
// Extras din /api/maintain pentru a putea fi apelat și de cron-ul intern
// (instrumentation → maintain-scheduler), fără auto-apel HTTP.
// ============================================================
import { q, qRead } from "@/lib/pg";
import { invalidateSearchCache } from "@/lib/neon-search";

export type MaintainOp = "all" | "ensure_partitions" | "cleanup_cache" | "refresh_rollup" | "stats";
export type MaintainReport = Record<string, unknown>;

/** creează partițiile search_logs lipsă pentru anii [year..year+ahead] */
async function ensurePartitions(ahead = 3): Promise<string[]> {
  const created: string[] = [];
  const nowYear = new Date().getUTCFullYear();
  for (let y = nowYear; y <= nowYear + ahead; y++) {
    for (const half of ["a", "b"]) {
      const name = `search_logs_${y}${half}`;
      const from = half === "a" ? `${y}-01-01` : `${y}-07-01`;
      const to = half === "a" ? `${y}-07-01` : `${y + 1}-01-01`;
      try {
        await q(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF search_logs FOR VALUES FROM ('${from}') TO ('${to}')`
        );
        // „created” doar dacă chiar acum a apărut (era lipsă)
        const chk = await qRead(`SELECT 1 FROM pg_tables WHERE tablename = '${name}'`);
        if (chk.length) created.push(name);
      } catch {
        // partiția există deja sau overlap — ignorăm (idempotent)
      }
    }
  }
  return created;
}

async function cleanupCache(): Promise<number> {
  const r = await q(
    `DELETE FROM search_cache WHERE created_at < now() - interval '10 minutes' RETURNING key`
  );
  return r.length;
}

async function refreshRollup(): Promise<{ buckets: number }> {
  for (const len of [1, 2, 3]) {
    await q(`SELECT refresh_suggest_rollup($1)`, [len]);
  }
  const r = await qRead<{ n: string }>(`SELECT count(*) AS n FROM suggest_rollup`);
  return { buckets: Number(r[0]?.n || 0) };
}

async function stats(): Promise<Record<string, unknown>> {
  const parts = await qRead<{ n: string }>(
    `SELECT count(*) AS n FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname IN ('content','search_logs','playback_events')`
  );
  const cacheRows = await qRead<{ n: string }>(`SELECT count(*) AS n FROM search_cache`);
  const rollup = await qRead<{ n: string }>(`SELECT count(*) AS n FROM suggest_rollup`);
  const lib = await qRead<{ n: string }>(`SELECT count(*) AS n FROM content`);
  const size = await qRead<{ s: string }>(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS s`
  );
  const logs24h = await qRead<{ n: string }>(
    `SELECT count(*) AS n FROM search_logs WHERE created_at > now() - interval '24 hours'`
  );
  return {
    libraryItems: Number(lib[0]?.n || 0),
    totalPartitions: Number(parts[0]?.n || 0),
    searchCacheRows: Number(cacheRows[0]?.n || 0),
    rollupBuckets: Number(rollup[0]?.n || 0),
    searchLogs24h: Number(logs24h[0]?.n || 0),
    dbSize: size[0]?.s || "n/a",
    at: new Date().toISOString(),
  };
}

/** Rulează un ciclu complet de mentenanță. Aruncă doar erori reale de DB. */
export async function runMaintenance(op: MaintainOp = "all"): Promise<MaintainReport> {
  const report: MaintainReport = { ok: true, op, at: new Date().toISOString() };

  if (op === "all" || op === "ensure_partitions") {
    report.partitions = await ensurePartitions();
  }
  if (op === "all" || op === "cleanup_cache") {
    report.deletedCacheRows = await cleanupCache();
  }
  if (op === "all" || op === "refresh_rollup") {
    report.rollup = await refreshRollup();
    invalidateSearchCache("sug:");
  }
  if (op === "all" || op === "stats") {
    report.stats = await stats();
  }
  return report;
}
