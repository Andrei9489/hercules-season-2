// ============================================================
// FAZA 13 — MENTENANȚĂ: nucleu partajat (route + scheduler intern)
// Operațiuni (idempotente, sigure la rulare repetată):
//   • ensure_partitions — partiții search_logs pentru anii curent..+3
//   • cleanup_cache     — rândurile expirate din search_cache (L2 distribuit)
//   • refresh_rollup    — re-materializează bucket-ele de sugestii 1-3
//   • stats             — raport de sănătate (partiții, cache, dimensiune DB)
// FAZA 18:
//   • probe_regions     — ping LIVE pe toate regiunile multi-region +health în Neon
//   • cleanup_recommend_cache — payload-uri recomandări expirate
// FAZA 19:
//   • cleanup_cluster_nodes — heartbeat-uri moarte (>1h) din cluster_nodes
// Extras din /api/maintain pentru a putea fi apelat și de cron-ul intern
// (instrumentation → maintain-scheduler), fără auto-apel HTTP.
// ============================================================
import { q, qRead } from "@/lib/pg";
import { invalidateSearchCache } from "@/lib/neon-search";

export type MaintainOp =
  | "all"
  | "ensure_partitions"
  | "cleanup_cache"
  | "refresh_rollup"
  | "probe_regions"
  | "cleanup_recommend_cache"
  | "cleanup_cluster_nodes"
  | "stats";
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
  if (op === "all" || op === "probe_regions") {
    // FAZA 18a — sănătate multi-region auto-actualizată (fără intervenție ops):
    // probe SELECT 1 pe fiecare endpoint configurat → update în Neon (regions.health)
    try {
      const { probeAllRegions } = await import("@/lib/regions");
      const probes = await probeAllRegions();
      report.regions = {
        probed: probes.length,
        ok: probes.filter((p) => p.ok).length,
        detail: probes,
      };
    } catch (e) {
      report.regions = { error: String(e).slice(0, 200) };
    }
  }
  if (op === "all" || op === "cleanup_recommend_cache") {
    try {
      const r = await q(
        `DELETE FROM ai_recommend_cache WHERE expires_at < now() RETURNING cache_key`
      );
      report.recommendCacheDeleted = r.length;
    } catch {
      // tabelul nu există încă (before DDL v18) — non-blocant
      report.recommendCacheDeleted = 0;
    }
  }
  if (op === "all" || op === "cleanup_cluster_nodes") {
    // FAZA 19a — heartbeat-uri moarte: instanțe care nu s-au publicat >1h
    // (crash/OOM/scală-in) rămân în cluster_nodes și încarcă registry-ul.
    try {
      const r = await q(
        `DELETE FROM cluster_nodes WHERE seen_at < now() - interval '1 hour' RETURNING instance_id`
      );
      report.clusterNodesDeleted = r.length;
    } catch {
      // tabelul nu există încă (before DDL v19) — non-blocant
      report.clusterNodesDeleted = 0;
    }
  }
  return report;
}
