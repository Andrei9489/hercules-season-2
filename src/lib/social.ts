/**
 * FAZA 20b — STRAT SOCIAL REAL (totul în Neon, zero simulare)
 *
 * Comentarii publice per conținut + reacții (like) + urmăritori +
 * feed de activitate. Cache L2 DISTRIBUIT în Neon (tabel social_cache,
 * partajat între toate instanțele clusterului — aceeași convenție ca
 * search_cache / ai_recommend_cache din Fazele 4/18).
 *
 * Particularitate de design: lista de bază a comentariilor (fără starea
 * privind viewer-ul) e cache-uită L2 per media; câmpul „viewerLiked" se
 * rezolvă per-user la servire cu o singură interogare pe pagina curentă —
 * așa cache-ul e partajabil între toți utilizatorii fără scurgeri de stare.
 */
import { q, qRead, qOne } from "@/lib/pg";

export type SocialComment = {
  id: string;
  userId: string;
  userName: string | null;
  userImage: string | null;
  body: string;
  createdAt: string;
  likes: number;
  viewerLiked: boolean;
};

type BaseCommentRow = {
  id: string;
  userId: string;
  userName: string | null;
  userImage: string | null;
  body: string;
  createdAt: string;
  likes: number;
};

export type ActivityItem = {
  id: number;
  userId: string;
  userName: string | null;
  userImage: string | null;
  kind: string;
  mediaId: string | null;
  mediaType: string | null;
  title: string | null;
  poster: string | null;
  createdAt: string;
};

// ── L2 distribuit în Neon (social_cache) ─────────────────────────

async function l2Get<T>(key: string): Promise<T | null> {
  try {
    const r = await qRead<{ payload: T }>(
      `SELECT payload FROM social_cache WHERE key = $1 AND created_at > now() - ($2::text)::interval`,
      [key, "45 seconds"]
    );
    return r.length ? (r[0].payload as T) : null;
  } catch {
    return null; // optimist — L2 nu blochează niciodată
  }
}

async function l2Set(key: string, payload: unknown): Promise<void> {
  try {
    await q(
      `INSERT INTO social_cache (key, payload) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET payload = $2::jsonb, created_at = now()`,
      [key, JSON.stringify(payload)]
    );
  } catch {
    // optimist
  }
}

/** Invalidare L2 pentru lista de comentarii a unui media. */
export async function invalidateCommentsCache(mediaId?: string): Promise<void> {
  try {
    if (mediaId) {
      await q(`DELETE FROM social_cache WHERE key LIKE $1`, [`soc:cm:${mediaId}:%`]);
    } else {
      await q(`DELETE FROM social_cache WHERE key LIKE 'soc:cm:%'`);
    }
  } catch {
    // optimist
  }
}

/** Curățare cache expirate (cron mentenanță). */
export async function cleanupSocialCache(): Promise<number> {
  try {
    const r = await q<{ id?: string }>(
      `DELETE FROM social_cache WHERE created_at < now() - interval '10 minutes'`
    );
    return r.length || 0;
  } catch {
    return 0;
  }
}

// ── Sanitizare ───────────────────────────────────────────────────

/** Strip caractere de control + trim + limită dură 1000 chars. */
export function sanitizeBody(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 1000);
}

// ── Comentarii ───────────────────────────────────────────────────

export async function addComment(
  userId: string,
  mediaId: string,
  mediaType: string,
  body: string
): Promise<SocialComment> {
  const clean = sanitizeBody(body);
  if (clean.length < 1)
    throw new Error("Comentariul gol");
  const id = (await qOne<{ id: string }>(
    `INSERT INTO social_comment (id, "userId", "mediaId", "mediaType", body)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4) RETURNING id`,
    [userId, mediaId, mediaType, clean]
  ))?.id;
  void recordActivity(userId, "comment", { mediaId, mediaType, body: clean.slice(0, 80) }).catch(() => {});
  await invalidateCommentsCache(mediaId);
  return {
    id: id as string,
    userId,
    userName: null, // UI-ul refetchuiește lista — câmpurile complete vin din listComments
    userImage: null,
    body: clean,
    createdAt: new Date().toISOString(),
    likes: 0,
    viewerLiked: false,
  };
}

/** Listă de bază (fără stare viewer) — cu L2 distribuit. */
async function baseComments(
  mediaId: string,
  mediaType: string,
  limit: number,
  offset: number
): Promise<{ items: BaseCommentRow[]; total: number }> {
  const key = `soc:cm:${mediaId}:${mediaType}:${Math.floor(offset / Math.max(1, limit))}:${limit}`;
  const cached = await l2Get<{ items: BaseCommentRow[]; total: number }>(key);
  if (cached) return cached;

  const [items, totalRow] = await Promise.all([
    q<BaseCommentRow>(
      `SELECT c.id, c."userId" AS "userId", c.body, c."createdAt",
              u.name AS "userName", u.image AS "userImage",
              (SELECT count(*)::int FROM social_reaction r WHERE r."targetId" = c.id) AS likes
       FROM social_comment c JOIN "User" u ON u.id = c."userId"
       WHERE c."mediaId" = $1 AND c."mediaType" = $2
       ORDER BY c."createdAt" DESC LIMIT $3 OFFSET $4`,
      [mediaId, mediaType, limit, offset]
    ),
    qOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM social_comment WHERE "mediaId" = $1 AND "mediaType" = $2`,
      [mediaId, mediaType]
    ),
  ]);
  const out = { items, total: totalRow?.n ?? 0 };
  await l2Set(key, out);
  return out;
}

/** Listă publică + stare viewer rezolvată per cerere (fără cache per-user). */
export async function listComments(
  mediaId: string,
  mediaType: string,
  viewerId: string | null,
  limit = 20,
  offset = 0
): Promise<{ items: SocialComment[]; total: number }> {
  const base = await baseComments(mediaId, mediaType, limit, offset);
  if (!viewerId || base.items.length === 0) {
    return {
      items: base.items.map((c) => ({ ...c, viewerLiked: false })),
      total: base.total,
    };
  }
  const ids = base.items.map((c) => c.id);
  const liked = await q<{ targetId: string }>(
    `SELECT "targetId" FROM social_reaction
     WHERE "userId" = $1 AND kind = 'like' AND "targetId" = ANY($2::text[])`,
    [viewerId, ids]
  );
  const likedSet = new Set(liked.map((r) => r.targetId));
  return {
    items: base.items.map((c) => ({ ...c, viewerLiked: likedSet.has(c.id) })),
    total: base.total,
  };
}

export async function deleteComment(userId: string, commentId: string): Promise<boolean> {
  const row = await qOne<{ mediaId: string }>(
    `DELETE FROM social_comment WHERE id = $1 AND "userId" = $2 RETURNING "mediaId"`,
    [commentId, userId]
  );
  if (!row) return false;
  await invalidateCommentsCache(row.mediaId);
  return true;
}

// ── Reacții (like) ───────────────────────────────────────────────

export async function toggleCommentLike(
  userId: string,
  commentId: string
): Promise<{ active: boolean }> {
  const existing = await qOne<{ targetId: string }>(
    `SELECT "targetId" FROM social_reaction WHERE "userId" = $1 AND "targetId" = $2 AND kind = 'like'`,
    [userId, commentId]
  );
  if (existing) {
    await q(
      `DELETE FROM social_reaction WHERE "userId" = $1 AND "targetId" = $2 AND kind = 'like'`,
      [userId, commentId]
    );
    await invalidateLike(commentId);
    return { active: false };
  }
  await q(
    `INSERT INTO social_reaction ("userId", "targetId", kind) VALUES ($1, $2, 'like')
     ON CONFLICT ("userId", "targetId", kind) DO NOTHING`,
    [userId, commentId]
  );
  void recordActivity(userId, "like", { commentId }).catch(() => {});
  await invalidateLike(commentId);
  return { active: true };
}

/** Invalidare L2 pentru media comentariului (contorul like e în lista de bază). */
async function invalidateLike(commentId: string): Promise<void> {
  try {
    const c = await qOne<{ mediaId: string }>(
      `SELECT "mediaId" FROM social_comment WHERE id = $1`,
      [commentId]
    );
    if (c) await invalidateCommentsCache(c.mediaId);
  } catch { /* optimist */ }
}

// ── Urmăritori ───────────────────────────────────────────────────

export async function toggleFollow(
  followerId: string,
  followeeId: string
): Promise<{ active: boolean }> {
  if (followerId === followeeId)
    throw new Error("Nu te poți urmări pe tine");
  const existing = await qOne<{ followeeId: string }>(
    `SELECT "followeeId" FROM social_follow WHERE "followerId" = $1 AND "followeeId" = $2`,
    [followerId, followeeId]
  );
  if (existing) {
    await q(
      `DELETE FROM social_follow WHERE "followerId" = $1 AND "followeeId" = $2`,
      [followerId, followeeId]
    );
    return { active: false };
  }
  await q(
    `INSERT INTO social_follow ("followerId", "followeeId") VALUES ($1, $2)
     ON CONFLICT ("followerId", "followeeId") DO NOTHING`,
    [followerId, followeeId]
  );
  void recordActivity(followerId, "follow", { targetId: followeeId }).catch(() => {});
  return { active: true };
}

export async function followStatus(
  viewerId: string | null,
  targetId: string
): Promise<{ followers: number; following: number; viewerFollows: boolean; followsViewer: boolean }> {
  const [followers, following, viewerFollows, followsViewer] = await Promise.all([
    qOne<{ n: number }>(`SELECT count(*)::int AS n FROM social_follow WHERE "followeeId" = $1`, [targetId]),
    qOne<{ n: number }>(`SELECT count(*)::int AS n FROM social_follow WHERE "followerId" = $1`, [targetId]),
    viewerId
      ? qOne<{ n: number }>(
          `SELECT count(*)::int AS n FROM social_follow WHERE "followerId" = $1 AND "followeeId" = $2`,
          [viewerId, targetId]
        )
      : Promise.resolve({ n: 0 }),
    viewerId
      ? qOne<{ n: number }>(
          `SELECT count(*)::int AS n FROM social_follow WHERE "followerId" = $1 AND "followeeId" = $2`,
          [targetId, viewerId]
        )
      : Promise.resolve({ n: 0 }),
  ]);
  return {
    followers: followers?.n ?? 0,
    following: following?.n ?? 0,
    viewerFollows: (viewerFollows?.n ?? 0) > 0,
    followsViewer: (followsViewer?.n ?? 0) > 0,
  };
}

// ── Feed activitate ──────────────────────────────────────────────

export async function recordActivity(
  userId: string,
  kind: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  await q(
    `INSERT INTO social_activity ("userId", kind, "mediaId", "mediaType", title, poster, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      userId,
      kind,
      (meta.mediaId as string) || null,
      (meta.mediaType as string) || null,
      (meta.title as string) || null,
      (meta.poster as string) || null,
      JSON.stringify(meta),
    ]
  );
}

/**
 * Feed: autentificat → activitatea celor urmăriți (+ ai tăi);
 * anonim → feed global. Zero cache per-user; L2 doar pt. feed global.
 */
export async function activityFeed(
  viewerId: string | null,
  limit = 20
): Promise<{ items: ActivityItem[]; scope: "global" | "following" }> {
  if (!viewerId) {
    const key = `soc:feed:global:${limit}`;
    const cached = await l2Get<{ items: ActivityItem[]; scope: "global" | "following" }>(key);
    if (cached) return cached;
    const items = await q<ActivityItem>(
      `SELECT a.id, a."userId", a.kind, a."mediaId", a."mediaType", a.title, a.poster, a."createdAt",
              u.name AS "userName", u.image AS "userImage"
       FROM social_activity a JOIN "User" u ON u.id = a."userId"
       ORDER BY a."createdAt" DESC LIMIT $1`,
      [limit]
    );
    const out = { items, scope: "global" as const };
    void l2Set(key, out);
    return out;
  }
  const items = await q<ActivityItem>(
    `SELECT a.id, a."userId", a.kind, a."mediaId", a."mediaType", a.title, a.poster, a."createdAt",
            u.name AS "userName", u.image AS "userImage"
     FROM social_activity a JOIN "User" u ON u.id = a."userId"
     WHERE a."userId" = $1
        OR a."userId" IN (SELECT "followeeId" FROM social_follow WHERE "followerId" = $1)
     ORDER BY a."createdAt" DESC LIMIT $2`,
    [viewerId, limit]
  );
  return { items, scope: "following" };
}

// ── Statistici globale (pentru /api/status) ──────────────────────

export async function socialStats(): Promise<{
  comments: number; reactions: number; follows: number; activity24h: number;
}> {
  const [c, r, f, a] = await Promise.all([
    qOne<{ n: number }>(`SELECT count(*)::int AS n FROM social_comment`),
    qOne<{ n: number }>(`SELECT count(*)::int AS n FROM social_reaction`),
    qOne<{ n: number }>(`SELECT count(*)::int AS n FROM social_follow`),
    qOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM social_activity WHERE "createdAt" > now() - interval '24 hours'`
    ),
  ]);
  return {
    comments: c?.n ?? 0,
    reactions: r?.n ?? 0,
    follows: f?.n ?? 0,
    activity24h: a?.n ?? 0,
  };
}
