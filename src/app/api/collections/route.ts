import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getUserIdByEmail } from "@/lib/auth";
import { q, qOne } from "@/lib/pg";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";

// ============================================================
// FAZA 11 — COLECȚII PERSONALE (playlists utilizator)
// Colecțiile sunt containere create de utilizator în care
// organizează conținutul încărcat de el (URL/iframe/embed/JS).
// Stocare 100% Neon (tabele collections + collection_items).
// Integritate logică vs. content (tabel partiționat): la citire
// folosim LEFT JOIN — itemii orfani (conținut șters) nu rup UI-ul.
// ============================================================

async function requireUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return getUserIdByEmail(session.user.email);
}

const MAX_COLLECTIONS = 100;
const MAX_ITEMS = 2000;

type Body = {
  action: "create" | "add" | "remove" | "delete" | "update";
  id?: string;
  name?: string;
  description?: string;
  isPublic?: boolean;
  contentId?: number;
};

/** recompută items_count + posterul reprezentativ al unei colecții */
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

export async function GET(req: NextRequest) {
  const rl = rateLimit(`collg:${clientIp(req)}`, { burst: 60, perMinute: 240 });
  if (!rl.ok) return tooMany(rl);

  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ authed: false, collections: [], items: [] });

  const id = req.nextUrl.searchParams.get("id");

  if (id) {
    // detaliu colecție + itemi (LEFT JOIN — orfanii nu rup lista)
    const col = await qOne(
      `SELECT id, name, description, is_public AS "isPublic",
              items_count AS "itemsCount", poster_url AS "posterUrl", created_at AS "createdAt"
       FROM collections WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!col) return NextResponse.json({ error: "Colecția nu există" }, { status: 404 });
    const items = await q(
      `SELECT ct.id, ct.title, ct.content_type AS "contentType", ct.provider,
              ct.source_type AS "sourceType", ct.source_url AS "sourceUrl",
              ct.embed_code AS "embedCode", ct.thumbnail, ct.backdrop,
              ct.year, ct.rating, ct.views, ct.meta ? 'signing' AS signed,
              ci.added_at AS "addedAt"
       FROM collection_items ci
       LEFT JOIN content ct ON ct.id = ci.content_id
       WHERE ci.collection_id = $1
       ORDER BY ci.added_at DESC
       LIMIT ${MAX_ITEMS}`,
      [id]
    );
    // itemi orfani (conținut șters între timp) — întoarcem doar cei existenți
    return NextResponse.json({
      authed: true,
      collection: col,
      items: items.filter((i: { id: unknown }) => i.id !== null),
    });
  }

  const collections = await q(
    `SELECT id, name, description, is_public AS "isPublic",
            items_count AS "itemsCount", poster_url AS "posterUrl",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM collections WHERE user_id = $1
     ORDER BY updated_at DESC LIMIT ${MAX_COLLECTIONS}`,
    [userId]
  );
  return NextResponse.json({ authed: true, collections });
}

export async function POST(req: NextRequest) {
  const rl = rateLimit(`collp:${clientIp(req)}`, { burst: 30, perMinute: 120 });
  if (!rl.ok) return tooMany(rl);

  const userId = await requireUserId();
  if (!userId)
    return NextResponse.json({ error: "Autentificare necesară" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.action)
    return NextResponse.json({ error: "Acțiune lipsă" }, { status: 400 });

  try {
    if (body.action === "create") {
      const name = (body.name || "").trim().slice(0, 120);
      if (name.length < 1)
        return NextResponse.json({ error: "Numele colecției este obligatoriu" }, { status: 400 });
      const n = await qOne<{ c: string }>(
        `SELECT count(*) AS c FROM collections WHERE user_id = $1`, [userId]
      );
      if (Number(n?.c || 0) >= MAX_COLLECTIONS)
        return NextResponse.json(
          { error: `Maxim ${MAX_COLLECTIONS} colecții` }, { status: 400 }
        );
      const col = await qOne(
        `INSERT INTO collections (id, user_id, name, description, is_public)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
         ON CONFLICT (user_id, lower(name)) DO UPDATE SET description = EXCLUDED.description
         RETURNING id, name`,
        [userId, name, (body.description || "").trim().slice(0, 500), body.isPublic || false]
      );
      return NextResponse.json({ ok: true, collection: col });
    }

    if (body.action === "update" && body.id) {
      const name = body.name !== undefined ? body.name.trim().slice(0, 120) : undefined;
      const col = await qOne(
        `UPDATE collections SET
           name = COALESCE($3, name),
           description = COALESCE($4, description),
           is_public = COALESCE($5, is_public),
           updated_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING id, name`,
        [body.id, userId, name, body.description?.trim().slice(0, 500), body.isPublic]
      );
      if (!col) return NextResponse.json({ error: "Colecția nu există" }, { status: 404 });
      return NextResponse.json({ ok: true, collection: col });
    }

    if (body.action === "delete" && body.id) {
      await q(`DELETE FROM collection_items WHERE collection_id = $1`, [body.id]);
      const r = await qOne<{ id: string }>(
        `DELETE FROM collections WHERE id = $1 AND user_id = $2 RETURNING id`,
        [body.id, userId]
      );
      if (!r) return NextResponse.json({ error: "Colecția nu există" }, { status: 404 });
      return NextResponse.json({ ok: true });
    }

    if ((body.action === "add" || body.action === "remove") && body.id && body.contentId) {
      // colecția trebuie să aparțină utilizatorului
      const own = await qOne<{ id: string }>(
        `SELECT id FROM collections WHERE id = $1 AND user_id = $2`,
        [body.id, userId]
      );
      if (!own) return NextResponse.json({ error: "Colecția nu există" }, { status: 404 });

      if (body.action === "add") {
        // conținutul trebuie să existe (integritate logică pe tabel partiționat)
        const exists = await qOne<{ id: number }>(
          `SELECT id FROM content WHERE id = $1`, [body.contentId]
        );
        if (!exists) return NextResponse.json({ error: "Conținutul nu există" }, { status: 404 });
        const cnt = await qOne<{ c: string }>(
          `SELECT count(*) AS c FROM collection_items WHERE collection_id = $1`, [body.id]
        );
        if (Number(cnt?.c || 0) >= MAX_ITEMS)
          return NextResponse.json({ error: `Maxim ${MAX_ITEMS} itemi/colecție` }, { status: 400 });
        await q(
          `INSERT INTO collection_items (collection_id, content_id) VALUES ($1, $2)
           ON CONFLICT (collection_id, content_id) DO NOTHING`,
          [body.id, body.contentId]
        );
      } else {
        await q(
          `DELETE FROM collection_items WHERE collection_id = $1 AND content_id = $2`,
          [body.id, body.contentId]
        );
      }
      await recount(body.id);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Acțiune invalidă" }, { status: 400 });
  } catch (e) {
    console.error("Collections POST error:", e);
    return NextResponse.json({ error: "Eroare internă" }, { status: 500 });
  }
}
