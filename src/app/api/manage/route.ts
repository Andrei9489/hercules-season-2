import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { q, qOne } from "@/lib/pg";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";
import {
  scanDuplicates,
  checkDuplicate,
  deleteContentByIds,
  dedupeGroups,
  duplicateQuickCount,
} from "@/lib/duplicates";
import { shardsStatus } from "@/lib/shards";

// ============================================================
// FAZA 16 — /api/manage: GESTIONAREA BIBLIOTECII (postere + conținuturi)
// GET  ?tab=posters|content|duplicates|quick — listare + scan duplicate
// POST {action: delete|dedupe|check}         — ștergere BULK multi-select
//        + dedupe automat + verificare duplicat live (gardă la încărcare)
// Protecție scrieri: sesiune autentificată SAU x-shard-token (admin).
// ============================================================

const TOKEN = process.env.NEON_SHARD_TOKEN || "sv15-shard-Kq9w2Rm8Tb5Xz1Lp";

async function writeAuthed(req: NextRequest): Promise<string | null> {
  if ((req.headers.get("x-shard-token") || "") === TOKEN) return "token";
  const session = await getServerSession(authOptions).catch(() => null);
  return session?.user?.email || null;
}

type ListRow = Record<string, unknown>;

/** GET /api/manage — listare pentru panoul de gestionare */
export async function GET(req: NextRequest) {
  const rl = rateLimit(`manage:${clientIp(req)}`, { burst: 30, perMinute: 90 });
  if (!rl.ok) return tooMany(rl);

  const sp = req.nextUrl.searchParams;
  const tab = sp.get("tab") || "posters";
  const limit = Math.min(120, Number(sp.get("limit")) || 24);
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  const query = (sp.get("q") || "").trim();

  try {
    if (tab === "duplicates") {
      const scan = await scanDuplicates();
      const remote = await shardsStatus().catch(() => null);
      return NextResponse.json({
        ok: true,
        ...scan,
        remoteRows: remote ? remote.rowsPerShard.reduce((s, r) => s + Math.max(0, r), 0) : 0,
      });
    }

    if (tab === "quick") {
      const quick = await duplicateQuickCount();
      return NextResponse.json({ ok: true, ...quick });
    }

    const where: string[] = ["TRUE"];
    const params: unknown[] = [];
    if (query) {
      params.push(`%${query.toLowerCase()}%`);
      where.push(`lower(title) LIKE $${params.length}`);
    }

    if (tab === "content") {
      params.push(limit, offset);
      const rows = await q<ListRow>(
        `SELECT id, external_id, title, content_type, provider, source_type,
                source_url, thumbnail, year, popularity, views, created_by, created_at
         FROM content WHERE ${where.join(" AND ")}
         ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
      );
      const total = await qOne<{ n: string }>(
        `SELECT count(*)::text AS n FROM content WHERE ${where.join(" AND ")}`,
        params.slice(0, params.length - 2)
      ).catch(() => null);
      return NextResponse.json({
        ok: true,
        items: rows.map((r) => ({
          id: Number(r.id),
          externalId: String(r.external_id),
          title: String(r.title),
          contentType: String(r.content_type),
          provider: String(r.provider),
          sourceType: String(r.source_type),
          sourceUrl: (r.source_url as string) || null,
          thumbnail: (r.thumbnail as string) || null,
          year: r.year == null ? null : Number(r.year),
          popularity: Number(r.popularity) || 0,
          views: Number(r.views) || 0,
          createdBy: (r.created_by as string) || null,
          createdAt: (r.created_at as string) || null,
        })),
        total: Number(total?.n || 0),
        limit,
        offset,
      });
    }

    // tab implicit: posters (grilă vizuală pentru selecție multiplă)
    params.push(limit, offset);
    const listSql = `SELECT id, title, content_type, provider, thumbnail, backdrop, year,
              popularity, views, created_at
       FROM content WHERE ${where.join(" AND ")}
       ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    let rows: ListRow[];
    try {
      rows = await q<ListRow>(listSql, params);
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
    const total = await qOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM content WHERE ${where.join(" AND ")}`,
      params.slice(0, params.length - 2)
    ).catch(() => null);
    return NextResponse.json({
      ok: true,
      items: rows.map((r) => ({
        id: Number(r.id),
        title: String(r.title),
        contentType: String(r.content_type),
        provider: String(r.provider),
        thumbnail: (r.thumbnail as string) || null,
        backdrop: (r.backdrop as string) || null,
        year: r.year == null ? null : Number(r.year),
        popularity: Number(r.popularity) || 0,
        views: Number(r.views) || 0,
        createdAt: (r.created_at as string) || null,
      })),
      total: Number(total?.n || 0),
      limit,
      offset,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

/** POST /api/manage — delete bulk | dedupe | check */
export async function POST(req: NextRequest) {
  const rl = rateLimit(`manage-post:${clientIp(req)}`, { burst: 20, perMinute: 60 });
  if (!rl.ok) return tooMany(rl);

  const actor = await writeAuthed(req);
  if (!actor) {
    return NextResponse.json(
      { error: "unauthorized", message: "Autentifică-te (sau folosește x-shard-token) pentru operațiuni de gestionare." },
      { status: 401 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const action = String(body.action || "");

  try {
    // ---------- CHECK: gardă duplicat la încărcare ----------
    if (action === "check") {
      const title = body.title ? String(body.title) : null;
      const contentType = body.contentType ? String(body.contentType) : null;
      const sourceUrl = body.sourceUrl ? String(body.sourceUrl) : null;
      const externalId = body.externalId ? String(body.externalId) : null;
      if (!title && !sourceUrl && !externalId) {
        return NextResponse.json({ error: "empty" }, { status: 400 });
      }
      const res = await checkDuplicate({ title, contentType, sourceUrl, externalId });
      return NextResponse.json({ ok: true, ...res });
    }

    // ---------- DELETE: ștergere BULK multi-select (max 500/call) ----------
    if (action === "delete") {
      const ids = Array.isArray(body.ids)
        ? (body.ids as unknown[]).map((x) => Number(x)).filter(Number.isFinite)
        : [];
      if (ids.length === 0) return NextResponse.json({ error: "no-ids" }, { status: 400 });
      if (ids.length > 500) {
        return NextResponse.json(
          { error: "too-many", message: "Maxim 500 conținuturi per operație — repeta pentru loturi mari." },
          { status: 400 }
        );
      }
      const res = await deleteContentByIds(ids, actor);
      return NextResponse.json({ ok: true, ...res });
    }

    // ---------- DEDUPE: eliminare automată a duplicatelor ----------
    if (action === "dedupe") {
      const keepRaw = String(body.keep || "first");
      const keep = (["first", "best", "newest"].includes(keepRaw) ? keepRaw : "first") as "first" | "best" | "newest";
      const groupKeys = Array.isArray(body.groupKeys) ? (body.groupKeys as unknown[]).map(String) : null;
      const res = await dedupeGroups(keep, groupKeys && groupKeys.length ? groupKeys : null, actor);
      return NextResponse.json({ ok: true, ...res });
    }

    return NextResponse.json({ error: "unknown-action", ops: ["check", "delete", "dedupe"] }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
