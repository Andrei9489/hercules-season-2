import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getUserIdByEmail } from "@/lib/auth";
import { q, qOne } from "@/lib/pg";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";
import { invalidateRecommendations } from "@/lib/recommendations";

// ============================================================
// FAZA 14 — NEON SYNC HUB
// Sincronizarea operațiunilor făcute OFFLINE (coada în browser)
// către Neon, cu IDEMPOTENȚĂ strictă:
//   • fiecare op are un opId (UUID generat client-side);
//   • același opId reaplicat = SKIP (nu se dublează nimic);
//   • colecțiile create offline primesc clientRef → serverId,
//     maparea persistă în sync_seen.result (cross-batch).
// Jurnal complet per rulare în sync_log (vizibil în panoul UI).
// ============================================================

async function requireUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return getUserIdByEmail(session.user.email);
}

// ---------- validare / sanitizare ----------
function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}
function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

type MediaRef = {
  mediaId: string;
  mediaType: string;
  title: string;
  poster: string | null;
  backdrop: string | null;
  year: string | null;
  rating: number | null;
  source: string;
};

function parseMedia(v: unknown): MediaRef | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const mediaId = str(m.mediaId, 200);
  const mediaType = str(m.mediaType, 40) || "video";
  if (!mediaId) return null;
  return {
    mediaId,
    mediaType,
    title: str(m.title, 300) || mediaId,
    poster: str(m.poster, 1000) || null,
    backdrop: str(m.backdrop, 1000) || null,
    year: str(m.year, 20) || null,
    rating: numOrNull(m.rating),
    source: str(m.source, 40) || "sync",
  };
}

// tipuri de operațiuni acceptate
const OP_TYPES = new Set([
  "user.watchlist.add",
  "user.watchlist.toggle",
  "user.watchlist.remove",
  "user.favorites.add",
  "user.favorites.toggle",
  "user.favorites.remove",
  "user.history.progress",
  "collections.create",
  "collections.update",
  "collections.delete",
  "collections.add",
  "collections.remove",
]);

type SyncOp = { opId: string; type: string; payload: Record<string, unknown> };
type OpResult = { opId: string; status: "applied" | "skipped" | "failed"; error?: string; serverId?: string };

/** rezolvă clientRef → serverId pentru o colecție creată offline */
async function resolveCollectionId(userId: string, ref: string): Promise<string | null> {
  if (!ref) return null;
  // deja serverId (uuid real)? verificăm existența
  const direct = await qOne<{ id: string }>(
    `SELECT id FROM collections WHERE id = $1 AND user_id = $2`,
    [ref, userId]
  );
  if (direct) return direct.id;
  // altfel caută maparea din sync_seen (create aplicat anterior)
  const mapped = await qOne<{ result: { serverId?: string } | null }>(
    `SELECT result FROM sync_seen WHERE "userId" = $1 AND "opId" = $2 AND type = 'collections.create'`,
    [userId, ref]
  );
  return mapped?.result?.serverId ?? null;
}

async function recount(cid: string): Promise<void> {
  await q(
    `UPDATE collections c SET
       items_count = COALESCE(s.n, 0),
       poster_url = COALESCE(
         (SELECT ct.thumbnail FROM collection_items ci
          JOIN content ct ON ct.id = ci.content_id
          WHERE ci.collection_id = c.id AND ct.thumbnail IS NOT NULL
          ORDER BY ci.added_at DESC LIMIT 1),
         c.poster_url),
       updated_at = now()
     FROM (SELECT count(*)::int AS n FROM collection_items WHERE collection_id = $1) s
     WHERE c.id = $1`,
    [cid]
  );
}

/** aplică o singură operațiune; aruncă eroare de logică pentru failed */
async function applyOp(userId: string, op: SyncOp): Promise<Record<string, unknown> | undefined> {
  const p = op.payload ?? {};
  switch (op.type) {
    // ---------- user: watchlist / favorites ----------
    case "user.watchlist.add":
    case "user.watchlist.toggle":
    case "user.favorites.add":
    case "user.favorites.toggle": {
      const media = parseMedia(p.media);
      if (!media) throw new Error("media invalid");
      const table = op.type.startsWith("user.watchlist") ? "Watchlist" : "Favorite";
      const existing = await qOne<{ id: string }>(
        `SELECT "id" FROM "${table}" WHERE "userId"=$1 AND "mediaId"=$2 AND "mediaType"=$3`,
        [userId, media.mediaId, media.mediaType]
      );
      if (existing && op.type.endsWith(".toggle")) {
        await q(`DELETE FROM "${table}" WHERE "id"=$1`, [existing.id]);
        return { active: false };
      }
      await q(
        `INSERT INTO "${table}" ("id","userId","mediaId","mediaType","title","poster","backdrop","year","rating","source")
         VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT ("userId","mediaId","mediaType")
         DO UPDATE SET "title"=$4,"poster"=$5,"backdrop"=$6,"year"=$7,"rating"=$8,"source"=$9`,
        [userId, media.mediaId, media.mediaType, media.title, media.poster, media.backdrop, media.year, media.rating, media.source]
      );
      return { active: true };
    }
    case "user.watchlist.remove":
    case "user.favorites.remove": {
      const media = parseMedia(p.media);
      if (!media) throw new Error("media invalid");
      const table = op.type.startsWith("user.watchlist") ? "Watchlist" : "Favorite";
      await q(`DELETE FROM "${table}" WHERE "userId"=$1 AND "mediaId"=$2 AND "mediaType"=$3`,
        [userId, media.mediaId, media.mediaType]);
      return { active: false };
    }
    // ---------- user: istoric / progres ----------
    case "user.history.progress": {
      const media = parseMedia(p.media);
      if (!media) throw new Error("media invalid");
      await q(
        `INSERT INTO "History" ("id","userId","mediaId","mediaType","title","poster","backdrop","year","rating","source","progress","duration","trailerKey")
         VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT ("userId","mediaId","mediaType")
         DO UPDATE SET "progress"=$10,"duration"=$11,"trailerKey"=$12,"updatedAt"=now()`,
        [userId, media.mediaId, media.mediaType, media.title, media.poster, media.backdrop,
         media.year, media.rating, media.source, numOrNull(p.progress) ?? 0, numOrNull(p.duration) ?? 0,
         str(p.trailerKey, 100) || null]
      );
      return { progress: numOrNull(p.progress) ?? 0 };
    }
    // ---------- colecții ----------
    case "collections.create": {
      const name = str(p.name, 120).trim();
      if (!name) throw new Error("nume lipsă");
      const created = await qOne<{ id: string }>(
        `INSERT INTO collections (id, user_id, name, description, is_public, items_count)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
         ON CONFLICT (user_id, lower(name)) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [userId, name, str(p.description, 500) || "", p.isPublic === true]
      );
      return { serverId: created?.id };
    }
    case "collections.update": {
      const id = await resolveCollectionId(userId, str(p.id, 100));
      if (!id) throw new Error("colecția nu există");
      await q(`UPDATE collections SET name = COALESCE(NULLIF($2,''), name), description = $3, updated_at = now()
               WHERE id = $1 AND user_id = $4`,
        [id, str(p.name, 120), str(p.description, 500) || "", userId]);
      return {};
    }
    case "collections.delete": {
      const id = await resolveCollectionId(userId, str(p.id, 100));
      if (!id) return {}; // deja ștearsă — ok, idempotent
      await q(`DELETE FROM collection_items WHERE collection_id = $1`, [id]);
      await q(`DELETE FROM collections WHERE id = $1 AND user_id = $2`, [id, userId]);
      return {};
    }
    case "collections.add": {
      const id = await resolveCollectionId(userId, str(p.id, 100));
      if (!id) throw new Error("colecția nu există");
      const contentId = numOrNull(p.contentId);
      if (!contentId) throw new Error("contentId lipsă");
      const exists = await qOne<{ id: number }>(`SELECT id FROM content WHERE id = $1`, [contentId]);
      if (!exists) throw new Error(`conținutul ${contentId} nu mai există`);
      await q(
        `INSERT INTO collection_items (collection_id, content_id) VALUES ($1, $2)
         ON CONFLICT (collection_id, content_id) DO NOTHING`,
        [id, contentId]
      );
      await recount(id);
      return { serverId: id };
    }
    case "collections.remove": {
      const id = await resolveCollectionId(userId, str(p.id, 100));
      if (!id) return {};
      const contentId = numOrNull(p.contentId);
      if (!contentId) throw new Error("contentId lipsă");
      await q(`DELETE FROM collection_items WHERE collection_id = $1 AND content_id = $2`, [id, contentId]);
      await recount(id);
      return {};
    }
    default:
      throw new Error("tip necunoscut");
  }
}

// ============================================================
// GET — status real Neon Sync (conectivitate + statistici + istoric)
// ============================================================
export async function GET(req: NextRequest) {
  const rl = rateLimit(`syncg:${clientIp(req)}`, { burst: 30, perMinute: 120 });
  if (!rl.ok) return tooMany(rl);

  const t0 = Date.now();
  try {
    // ping REAL pe Neon
    await q(`SELECT 1`);
    const pingMs = Date.now() - t0;

    const userId = await requireUserId();

    // statistici globale Neon
    const statsRows = await qOne<{
      content: string; size: string; partitions: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM content) AS content,
         pg_size_pretty(pg_database_size(current_database())) AS size,
         (SELECT count(*)::text FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r'
            AND (c.relname LIKE 'content_h%' OR c.relname LIKE 'playback_h%' OR c.relname LIKE 'search_logs%')) AS partitions`
    );

    const base: Record<string, unknown> = {
      ok: true,
      authed: !!userId,
      connected: true,
      pingMs,
      db: {
        provider: "Neon Cloud PostgreSQL",
        region: "eu-central-1 (AWS)",
        size: statsRows?.size ?? "?",
        partitions: Number(statsRows?.partitions ?? 0),
        content: Number(statsRows?.content ?? 0),
      },
      serverNow: new Date().toISOString(),
    };

    if (!userId) return NextResponse.json(base);

    // contorizez datele utilizatorului (toate în Neon)
    const counts = await qOne<{
      history: string; watchlist: string; favorites: string; collections: string; items: string; pendingSeen: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM "History" WHERE "userId"=$1) AS history,
        (SELECT count(*)::text FROM "Watchlist" WHERE "userId"=$1) AS watchlist,
        (SELECT count(*)::text FROM "Favorite" WHERE "userId"=$1) AS favorites,
        (SELECT count(*)::text FROM collections WHERE user_id=$1) AS collections,
        (SELECT COALESCE(sum(items_count),0)::text FROM collections WHERE user_id=$1) AS items,
        (SELECT count(*)::text FROM sync_seen WHERE "userId"=$1) AS "pendingSeen"`,
      [userId]
    );

    const lastSyncs = await q(
      `SELECT "pushed", "skipped", "failed", "opsByType", "durationMs", "ok", "device",
              "createdAt" AS "createdAt"
       FROM sync_log WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 8`,
      [userId]
    );

    return NextResponse.json({
      ...base,
      user: {
        history: Number(counts?.history ?? 0),
        watchlist: Number(counts?.watchlist ?? 0),
        favorites: Number(counts?.favorites ?? 0),
        collections: Number(counts?.collections ?? 0),
        collectionItems: Number(counts?.items ?? 0),
        seenOps: Number(counts?.pendingSeen ?? 0),
      },
      lastSyncs,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, connected: false, error: String(e).slice(0, 200), pingMs: Date.now() - t0 },
      { status: 503 }
    );
  }
}

// ============================================================
// POST — push batch de operațiuni offline → Neon (idempotent)
// ============================================================
export async function POST(req: NextRequest) {
  const rl = rateLimit(`syncp:${clientIp(req)}`, { burst: 20, perMinute: 60 });
  if (!rl.ok) return tooMany(rl);

  const userId = await requireUserId();
  if (!userId)
    return NextResponse.json({ error: "Autentificare necesară pentru sincronizare" }, { status: 401 });

  const t0 = Date.now();
  let device = "web";
  let ops: SyncOp[] = [];
  try {
    const body = (await req.json()) as { device?: string; ops?: SyncOp[] };
    device = str(body.device, 60) || "web";
    ops = Array.isArray(body.ops) ? body.ops : [];
    if (ops.length > 200) ops = ops.slice(0, 200);
  } catch {
    return NextResponse.json({ error: "JSON invalid" }, { status: 400 });
  }

  if (ops.length === 0) {
    return NextResponse.json({ ok: true, pushed: 0, skipped: 0, failed: 0, results: [] });
  }

  const results: OpResult[] = [];
  const byType: Record<string, number> = {};
  let pushed = 0, skipped = 0, failed = 0;

  for (const op of ops) {
    const opId = str(op?.opId, 80);
    const type = str(op?.type, 40);
    if (!opId || !OP_TYPES.has(type)) {
      results.push({ opId: opId || "?", status: "failed", error: "opId sau tip invalid" });
      failed++;
      continue;
    }
    try {
      // IDEMPOTENȚĂ: op deja aplicat → skip (nu se dublează)
      const seen = await qOne<{ opId: string }>(
        `SELECT "opId" FROM sync_seen WHERE "userId"=$1 AND "opId"=$2`,
        [userId, opId]
      );
      if (seen) {
        results.push({ opId, status: "skipped" });
        skipped++;
        continue;
      }
      const res = await applyOp(userId, { opId, type, payload: op.payload ?? {} });
      await q(
        `INSERT INTO sync_seen ("userId","opId","type","result") VALUES ($1,$2,$3,$4)
         ON CONFLICT ("userId","opId") DO NOTHING`,
        [userId, opId, type, res ? JSON.stringify(res) : null]
      );
      results.push({ opId, status: "applied", serverId: (res?.serverId as string) ?? undefined });
      pushed++;
      byType[type] = (byType[type] || 0) + 1;
    } catch (e) {
      results.push({ opId, status: "failed", error: String(e).slice(0, 160) });
      failed++;
    }
  }

  const durationMs = Date.now() - t0;
  try {
    await q(
      `INSERT INTO sync_log ("id","userId","device","pushed","skipped","failed","opsByType","durationMs","ok")
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, device, pushed, skipped, failed, JSON.stringify(byType), durationMs, failed === 0]
    );
  } catch (e) {
    console.error("sync_log insert failed:", e);
  }

  // Faza 18b — semnalele sincronizate offline schimbă profilul de recomandări
  if (pushed > 0) {
    void invalidateRecommendations(userId).catch(() => {});
  }

  return NextResponse.json({ ok: failed === 0, pushed, skipped, failed, results, durationMs });
}
