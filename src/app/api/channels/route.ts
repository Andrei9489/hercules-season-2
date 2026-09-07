import { NextRequest, NextResponse } from "next/server";
import { q, qOne } from "@/lib/pg";
import { cacheGet, cacheSet } from "@/lib/cache";
import { normalizeRo } from "@/lib/neon-search";
import { countryName } from "@/lib/countries";

// ============================================================
// /api/channels — canale TV live (Popular News) din Neon
// ?q= &country= &continent= &limit= &offset=
// ============================================================

export type ChannelRow = {
  id: number;
  title: string;
  description: string;
  thumbnail: string | null;
  provider: string;
  sourceType: string;
  sourceUrl: string | null;
  country: string | null;
  continent: string | null;
  category: string | null;
  popularity: number;
  views: number;
  quality: string | null;
  geoBlocked: boolean;
  not247: boolean;
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const qRaw = sp.get("q")?.trim() || "";
  const country = sp.get("country")?.trim() || "";
  const continent = sp.get("continent")?.trim() || "";
  const limit = Math.min(120, Math.max(12, Number(sp.get("limit")) || 48));
  const offset = Math.max(0, Number(sp.get("offset")) || 0);

  try {
    // ---- facet: țări cu număr de canale (cache 10 min) ----
    let countries: { code: string; name: string; n: number }[] = [];
    let totalAll = 0;
    const facetKey = "channels:facet:v1";
    const cachedFacet = cacheGet<{ countries: typeof countries; totalAll: number }>(facetKey);
    if (cachedFacet) {
      countries = cachedFacet.countries;
      totalAll = cachedFacet.totalAll;
    } else {
      const [facetRows, totalRow] = await Promise.all([
        q<Record<string, unknown>>(
          `SELECT country, count(*)::int AS n FROM content
           WHERE content_type = 'live_tv' AND country IS NOT NULL
           GROUP BY country ORDER BY n DESC`
        ),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content WHERE content_type = 'live_tv'`),
      ]);
      countries = facetRows.map((r) => ({
        code: String(r.country),
        name: countryName(String(r.country)),
        n: Number(r.n),
      }));
      totalAll = Number(totalRow?.n || 0);
      cacheSet(facetKey, { countries, totalAll }, 600);
    }

    // ---- interogare principală ----
    const params: unknown[] = [];
    let p = 0;
    const next = (v: unknown) => {
      params.push(v);
      p++;
      return `$${p}`;
    };
    let where = `content_type = 'live_tv'`;
    if (country) where += ` AND country = ${next(country.toLowerCase())}`;
    if (continent) where += ` AND continent = ${next(continent)}`;
    if (qRaw) {
      const norm = normalizeRo(qRaw).slice(0, 100);
      where += ` AND search_text LIKE ${next(`%${norm}%`)}`;
    }
    const limitPh = next(limit);
    const offsetPh = next(offset);
    const rows = await q<Record<string, unknown>>(
      `SELECT id, title, description, thumbnail, provider, source_type, source_url,
              country, continent, category, popularity, views,
              meta_quality AS quality, meta_geo AS "geoBlocked", meta_not247 AS "not247"
       FROM content
       WHERE ${where}
       ORDER BY popularity DESC, title ASC
       LIMIT ${limitPh} OFFSET ${offsetPh}`,
      params
    );

    const filteredTotal = qRaw || country || continent
      ? await qOne<{ n: string }>(
          `SELECT count(*)::text AS n FROM content WHERE ${where}`,
          params.slice(0, params.length - 2)
        )
      : null;

    const items: ChannelRow[] = rows.map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      description: String(r.description || ""),
      thumbnail: (r.thumbnail as string) || null,
      provider: String(r.provider),
      sourceType: String(r.source_type),
      sourceUrl: (r.source_url as string) || null,
      country: (r.country as string) || null,
      continent: (r.continent as string) || null,
      category: (r.category as string) || null,
      popularity: Number(r.popularity) || 0,
      views: Number(r.views) || 0,
      quality: (r.quality as string) || null,
      geoBlocked: Boolean(r.geoBlocked),
      not247: Boolean(r.not247),
    }));

    return NextResponse.json({
      ok: true,
      items,
      total: totalAll,
      filteredTotal: filteredTotal ? Number(filteredTotal.n) : totalAll,
      countries,
      limit,
      offset,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
