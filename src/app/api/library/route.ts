import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { searchLibrary, insertContent, recordPlayback, normalizeRo } from "@/lib/neon-search";
import { q, qOne } from "@/lib/pg";
import { resolveSource, titleFromUrl } from "@/lib/source-resolver";

type Item = Record<string, unknown>;

/** GET /api/library?limit=18&offset=0&type=movie&brand=marvel&q=... */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(60, Number(sp.get("limit")) || 18);
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  const type = sp.get("type") || undefined;
  const brand = sp.get("brand") || undefined;
  const query = sp.get("q") || "";
  const withFacets = sp.get("facets") === "1";

  let hits: Awaited<ReturnType<typeof searchLibrary>>["hits"] = [];
  let tookMs = 0;
  try {
    if (query.trim()) {
      const r = await searchLibrary(query, { limit, offset, type, brand });
      hits = r.hits;
      tookMs = r.tookMs;
    } else {
      // listare index-driven (popularity DESC)
      let where = "TRUE";
      const params: unknown[] = [];
      if (type) { params.push(type); where += ` AND content_type = $${params.length}`; }
      if (brand) { params.push(brand); where += ` AND brand = $${params.length}`; }
      params.push(limit);
      const rows = await q<Item>(
        `SELECT id, external_id, title, original_title, description, content_type, brand, category,
                continent, country, provider, source_type, source_url, embed_code, thumbnail, backdrop,
                year, rating, popularity, views, 0 AS score
         FROM content WHERE ${where}
         ORDER BY popularity DESC, id DESC LIMIT $${params.length} OFFSET $${params.length + 1}`,
        [...params, offset]
      );
      hits = rows.map(rowToHit);
    }
  } catch (e) {
    return NextResponse.json({ error: "db", message: String(e) }, { status: 500 });
  }

  const total = await qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content`).catch(() => null);

  const facets = withFacets
    ? await q<{ content_type: string; n: number }>(
        `SELECT content_type, count(*)::int AS n FROM content GROUP BY content_type ORDER BY n DESC`
      ).catch(() => [])
    : [];

  return NextResponse.json({
    items: hits.map(toApiItem),
    total: Number(total?.n || 0),
    tookMs,
    facets: facets.map((f) => ({ type: f.content_type, count: f.n })),
  });
}

type LibRow = {
  id: number; externalId: string; title: string; originalTitle: string | null; description: string;
  contentType: string; brand: string | null; category: string | null; continent: string | null;
  country: string | null; provider: string; sourceType: string; sourceUrl: string | null;
  embedCode: string | null; thumbnail: string | null; backdrop: string | null; year: number | null;
  rating: number; popularity: number; views: number; score: number;
};

function rowToHit(r: Record<string, unknown>): LibRow {
  return {
    id: Number(r.id),
    externalId: String(r.external_id),
    title: String(r.title),
    originalTitle: (r.original_title as string) || null,
    description: (r.description as string) || "",
    contentType: String(r.content_type),
    brand: (r.brand as string) || null,
    category: (r.category as string) || null,
    continent: (r.continent as string) || null,
    country: (r.country as string) || null,
    provider: String(r.provider),
    sourceType: String(r.source_type),
    sourceUrl: (r.source_url as string) || null,
    embedCode: (r.embed_code as string) || null,
    thumbnail: (r.thumbnail as string) || null,
    backdrop: (r.backdrop as string) || null,
    year: (r.year as number) || null,
    rating: (r.rating as number) || 0,
    popularity: Number(r.popularity) || 0,
    views: Number(r.views) || 0,
    score: Number(r.score) || 0,
  };
}

function toApiItem(h: LibRow) {
  return {
    id: h.id, externalId: h.externalId, title: h.title, originalTitle: h.originalTitle,
    description: h.description, contentType: h.contentType, brand: h.brand, category: h.category,
    continent: h.continent, country: h.country, provider: h.provider, sourceType: h.sourceType,
    sourceUrl: h.sourceUrl, embedCode: h.embedCode, thumbnail: h.thumbnail, backdrop: h.backdrop,
    year: h.year, rating: h.rating, popularity: h.popularity, views: h.views,
  };
}

/** POST /api/library — acțiuni: add | play_event | delete | preview */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const action = String(body.action || "");

  // ---------- PREVIEW: detectare sursă (fără salvare) ----------
  if (action === "preview") {
    const input = String(body.input || "");
    const resolved = resolveSource(input, { parent: req.headers.get("host") || "" });
    if (!resolved) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return NextResponse.json({ resolved });
  }

  // ---------- ADD: salvare în Neon ----------
  if (action === "add") {
    const input = String(body.input || "").trim();
    if (!input) return NextResponse.json({ error: "empty" }, { status: 400 });

    const resolved = resolveSource(input, { parent: req.headers.get("host") || "" });
    if (!resolved) return NextResponse.json({ error: "invalid-source" }, { status: 400 });

    const refUrl = resolved.kind === "html" ? "https://embed.local" : ((resolved as { src?: string; url?: string }).src || (resolved as { url?: string }).url || "");
    const title = String(body.title || "").trim() || titleFromUrl(refUrl === "https://embed.local" ? "Embed personalizat" : refUrl);
    if (!title) return NextResponse.json({ error: "no-title" }, { status: 400 });

    const contentType = String(body.contentType || "video");
    const brand = body.brand ? String(body.brand) : null;
    const country = body.country ? String(body.country) : null;

    // thumbnail automat pentru YouTube
    let thumb: string | null = null;
    const ytId = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/)|youtu\.be\/)([\w-]{6,})/i.exec(
      (resolved as { src?: string }).src || input
    );
    if (ytId) thumb = `https://i.ytimg.com/vi/${ytId[1]}/hqdefault.jpg`;

    const session = await getServerSession(authOptions).catch(() => null);
    const userId = session?.user?.email || null;

    const hashSrc = normalizeRo(`${title}|${input}`).replace(/\s/g, "").slice(0, 60);
    const extId = `user:${hashSrc}:${Date.now().toString(36)}`;

    const inserted = await insertContent({
      externalId: extId,
      title,
      description: String(body.description || `Conținut adăugat de utilizator — ${resolved.providerLabel}.`),
      contentType,
      brand,
      category: contentType,
      country,
      provider: resolved.provider,
      sourceType: resolved.kind === "html" ? "embed" : resolved.kind,
      sourceUrl: (resolved as { src?: string; url?: string }).src || (resolved.kind === "unknown" ? resolved.url : null),
      embedCode: resolved.kind === "html" ? resolved.html : String(body.embedCode || "") || null,
      thumbnail: thumb,
      year: body.year ? Number(body.year) : null,
      tags: ["adaugat", resolved.provider],
      meta: { resolved: resolved.provider, kind: resolved.kind },
      createdBy: userId,
    }).catch((e) => {
      console.error("library add:", e);
      return null;
    });

    if (!inserted) return NextResponse.json({ error: "insert-failed" }, { status: 500 });
    return NextResponse.json({ item: toApiItem(inserted), resolved });
  }

  // ---------- PLAY_EVENT: statistici redare ----------
  if (action === "play_event") {
    const contentId = Number(body.contentId || 0);
    if (!contentId) return NextResponse.json({ error: "no-id" }, { status: 400 });
    const session = await getServerSession(authOptions).catch(() => null);
    await recordPlayback(
      contentId,
      String(body.provider || "unknown"),
      String(body.event || "start"),
      Number(body.seconds || 0),
      session?.user?.email || null
    );
    return NextResponse.json({ ok: true });
  }

  // ---------- DELETE ----------
  if (action === "delete") {
    const id = Number(body.id || 0);
    if (!id) return NextResponse.json({ error: "no-id" }, { status: 400 });
    const row = await qOne<{ external_id: string }>(`SELECT external_id FROM content WHERE id = $1`, [id]);
    if (!row) return NextResponse.json({ error: "not-found" }, { status: 404 });
    // doar conținutul adăugat de utilizatori poate fi șters
    if (!row.external_id.startsWith("user:")) {
      return NextResponse.json({ error: "protected" }, { status: 403 });
    }
    await q(`DELETE FROM content WHERE id = $1`, [id]);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown-action" }, { status: 400 });
}
