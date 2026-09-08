// Faza 7 — BROWSE cu PAGINARE INFINITĂ AI (Home)
// GET /api/browse?page=1&size=20&type=movie&tax=genre&slug=actiune&sort=popularity
//  - size FIX 20 postere/pagină (cerință), pagini create automat din total
//  - filtre: tip conținut + orice taxonomie AI (gen/categorie/an/deceniu/
//    studio/franciză/colecție/trilogie) + sortare
//  - răspuns: items, page, size, total, totalPages, hasNext, hasPrev
import { NextRequest, NextResponse } from "next/server";
import { q, qRead } from "@/lib/pg";
import { normalizeRo } from "@/lib/neon-search";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

const SORTS: Record<string, string> = {
  popularity: "c.popularity DESC, c.views DESC",
  rating: "c.rating DESC NULLS LAST, c.popularity DESC",
  newest: "c.year DESC NULLS LAST, c.popularity DESC",
  oldest: "c.year ASC NULLS LAST",
  title: "c.title ASC",
  views: "c.views DESC, c.popularity DESC",
  newest_added: "c.created_at DESC",
};

// Faza 9: meniurile tematiche (Știri/Sport/Documentare/Muzică) includ și
// CANALE LIVE importate de utilizator (M3U) al căror grup/categorie indică
// tema — ex: playlistul „Popular News" ajunge și în meniul Știri, nu doar
// în TV Live. Cuvintele-cheie se compară pe category (ILIKE) și search_text
// (normalizat fără diacritice).
const TYPE_LIVE_KEYWORDS: Record<string, string[]> = {
  news: ["news", "stiri", "jurnal"],
  sport: ["sport", "sports"],
  documentary: ["documentary", "documentar"],
  music: ["music", "muzica"],
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const size = Math.min(20, Math.max(20, Number(sp.get("size")) || 20)); // FIX: 20 postere
  const type = (sp.get("type") || "").trim();
  const brand = (sp.get("brand") || "").trim();
  const taxKind = (sp.get("tax") || "").trim();
  const slug = (sp.get("slug") || "").trim();
  const search = (sp.get("q") || "").trim();
  const sort = SORTS[(sp.get("sort") || "popularity")] || SORTS.popularity;
  const offset = (page - 1) * size;

  const where: string[] = ["TRUE"];
  const params: unknown[] = [];
  if (type) {
    params.push(type);
    let cond = `c.content_type = $${params.length}`;
    const kws = TYPE_LIVE_KEYWORDS[type];
    if (kws) {
      params.push("live_tv");
      const tIdx = params.length;
      const kwConds = kws.flatMap((kw) => {
        params.push(`%${kw}%`);
        const a = params.length;
        params.push(`%${normalizeRo(kw)}%`);
        const b = params.length;
        return [`(c.category ILIKE $${a} OR c.search_text LIKE $${b})`];
      });
      cond += ` OR (c.content_type = $${tIdx} AND (${kwConds.join(" OR ")}))`;
    }
    where.push(`(${cond})`);
  }
  if (brand) { params.push(brand); where.push(`c.brand = $${params.length}`); }
  if (search) { params.push(`%${search}%`); where.push(`c.search_text LIKE $${params.length}`); }
  let joinTax = "";
  if (taxKind && slug) {
    params.push(taxKind); const kIdx = params.length;
    params.push(slug); const sIdx = params.length;
    joinTax = `JOIN content_genres cg ON cg.content_id = c.id
               JOIN genres g ON g.id = cg.genre_id AND g.kind = $${kIdx} AND g.slug = $${sIdx}`;
  }

  try {
    const whereSql = where.join(" AND ");
    const itemsRows = await qRead<Row>(
      `SELECT c.id, c.external_id, c.title, c.description, c.content_type, c.brand, c.category,
              c.continent, c.country, c.provider, c.source_type, c.source_url, c.embed_code,
              c.thumbnail, c.backdrop, c.year, c.rating, c.popularity, c.views
       FROM content c ${joinTax}
       WHERE ${whereSql}
       ORDER BY ${sort}
       LIMIT ${size} OFFSET ${offset}`,
      params
    );

    // count pe aceeași fereastră de filtre
    const countRows = await qRead<Row>(
      `SELECT count(*)::int AS n FROM content c ${joinTax} WHERE ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.n || 0);
    const totalPages = Math.max(1, Math.ceil(total / size));

    // taxonomiile prezente pe ACEASTĂ pagină (chips-uri contextuale AI)
    const pageIds = itemsRows.map((r) => Number(r.id));
    let pageGenres: { name: string; slug: string; kind: string }[] = [];
    if (pageIds.length > 0) {
      const gRows = await q<Row>(
        `SELECT g.name, g.slug, g.kind, count(*)::int AS n
         FROM content_genres cg JOIN genres g ON g.id = cg.genre_id
         WHERE cg.content_id = ANY($1::bigint[])
         GROUP BY g.name, g.slug, g.kind ORDER BY n DESC LIMIT 14`,
        [pageIds]
      );
      pageGenres = gRows.map((r) => ({ name: String(r.name), slug: String(r.slug), kind: String(r.kind) }));
    }

    return NextResponse.json({
      items: itemsRows.map((r) => ({
        id: Number(r.id),
        externalId: String(r.external_id),
        title: String(r.title),
        description: String(r.description || ""),
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
        rating: Number(r.rating || 0),
        popularity: Number(r.popularity || 0),
        views: Number(r.views || 0),
      })),
      page,
      size,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      pageGenres,
    });
  } catch (e) {
    return NextResponse.json({ error: "db", message: String(e) }, { status: 500 });
  }
}
