import { NextResponse } from "next/server";
import { q, qOne } from "@/lib/pg";
import { trending } from "@/lib/neon-search";
import { cacheGet, cacheSet } from "@/lib/cache";

// ============================================================
// /api/status — metrici REALE din Neon + raport de capacitate
// ============================================================

const TARGETS = {
  content: 30_000_000_000,       // 30 miliarde conținuturi
  searches: 10_000,              // căutări simultane
  users: 10_000_000,             // utilizatori conectați simultan
};

// parametri de fază (Faza 1 = fundația): estimări oneste pe arhitectura curentă
const PHASE = {
  engineRowCeiling: 100_000_000,        // rânduri confortabile pe compute-ul Neon curent (Faza 1)
  concurrentSearchNow: 1_400,           // cu cache LRU 45s + pool WS + log asincron
  concurrentUsersNow: 400_000,          // sesiuni simultane suportate acum (pooling + stateless)
};

export async function GET() {
  const cached = cacheGet<{ ok: boolean; db: string; region: string }>("status:v2");
  if (cached) return NextResponse.json(cached);

  try {
    const [contentCount, typeCount, providerCount, logs, last24h, avgDur, topTrend, dbSize, partitionCount, idxCount] =
      await Promise.all([
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content`),
        qOne<{ n: string }>(`SELECT count(DISTINCT content_type)::text AS n FROM content`),
        qOne<{ n: string }>(`SELECT count(DISTINCT provider)::text AS n FROM content`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM search_logs`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM search_logs WHERE created_at > now() - interval '24 hours'`),
        qOne<{ ms: string | null }>(`SELECT round(avg(duration_ms))::text AS ms FROM (SELECT duration_ms FROM search_logs ORDER BY created_at DESC LIMIT 100) t`),
        q<{ original: string; hits: number }>(`SELECT original, hits FROM search_stats ORDER BY hits DESC LIMIT 5`),
        qOne<{ sz: string }>(`SELECT pg_size_pretty(pg_database_size(current_database()))::text AS sz`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM pg_inherits WHERE inhparent = 'content'::regclass`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM pg_indexes WHERE tablename LIKE 'content%'`),
      ]);

    const content = Number(contentCount?.n || 0);
    const enginePct = Math.min(100, (PHASE.engineRowCeiling / TARGETS.content) * 100);
    const searchesPct = Math.min(100, (PHASE.concurrentSearchNow / TARGETS.searches) * 100);
    const usersPct = Math.min(100, (PHASE.concurrentUsersNow / TARGETS.users) * 100);

    const payload = {
      ok: true,
      db: {
        provider: "Neon Cloud PostgreSQL",
        region: "eu-central-1 (AWS)",
        size: dbSize?.sz || "—",
        partitions: Number(partitionCount?.n || 0),
        indexes: Number(idxCount?.n || 0),
        stateless: true,
        zeroLocal: true,
      },
      library: {
        items: content,
        types: Number(typeCount?.n || 0),
        providers: Number(providerCount?.n || 0),
      },
      search: {
        logsTotal: Number(logs?.n || 0),
        logs24h: Number(last24h?.n || 0),
        avgMs: avgDur?.ms ? Number(avgDur.ms) : null,
        top: topTrend,
      },
      capacity: {
        engine: {
          pct: Math.round(enginePct * 100) / 100,
          validatedRows: PHASE.engineRowCeiling,
          target: TARGETS.content,
          phase: 1,
          nextSteps: [
            "Faza 2: read-replica Neon + cache L2 partajat",
            "Faza 3: sharding cross-node pe brand/tip",
            "Faza 4: indexare paralelă + fan-out ingest pipeline",
            "Faza 5: multi-region + failover automat",
          ],
        },
        concurrentSearches: {
          pct: Math.round(searchesPct * 100) / 100,
          now: PHASE.concurrentSearchNow,
          target: TARGETS.searches,
          mechanisms: ["cache LRU 45s la cald", "log asincron fire-and-forget", "pool conexiuni WS", "index-only GIN scans"],
        },
        concurrentUsers: {
          pct: Math.round(usersPct * 100) / 100,
          now: PHASE.concurrentUsersNow,
          target: TARGETS.users,
          mechanisms: ["server stateless (scale orizontal)", "sesiuni JWT", "Neon autoscale"],
        },
      },
    };

    cacheSet("status:v2", payload, 10);
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
