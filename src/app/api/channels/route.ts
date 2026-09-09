import { NextRequest, NextResponse } from "next/server";
import { q, qOne } from "@/lib/pg";
import { cacheGet, cacheSet } from "@/lib/cache";
import { normalizeRo } from "@/lib/neon-search";
import { countryName } from "@/lib/countries";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";
import { withCache } from "@/lib/http-cache";

import { wrapMetrics } from "@/lib/http-cache";
// ============================================================
// /api/channels — canale TV live (Popular News) + RADIO LIVE din Neon
// ?q= &country= &continent= &limit= &offset= &type=live_tv|radio
// Faza 6: type=radio → posturi radio (radio-browser) cu bitrate/codec
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
  codec?: string | null;
  bitrate?: number | null;
};

async function getHandler(req: NextRequest) {
  // Faza 3: rate limiting per IP + cache HTTP la margine
  const rl = rateLimit(`chan:${clientIp(req)}`, { burst: 60, perMinute: 240 });
  if (!rl.ok) return tooMany(rl);

  const sp = req.nextUrl.searchParams;
  const qRaw = sp.get("q")?.trim() || "";
  const country = sp.get("country")?.trim() || "";
  const continent = sp.get("continent")?.trim() || "";
  const contentType = sp.get("type") === "radio" ? "radio" : "live_tv";
  const limit = Math.min(120, Math.max(12, Number(sp.get("limit")) || 48));
  const offset = Math.max(0, Number(sp.get("offset")) || 0);

  try {
    // ---- facet: țări cu număr de canale (cache 10 min, per tip) ----
    let countries: { code: string; name: string; n: number }[] = [];
    let totalAll = 0;
    const facetKey = `channels:facet:v2:${contentType}`;
    const cachedFacet = cacheGet<{ countries: typeof countries; totalAll: number }>(facetKey);
    if (cachedFacet) {
      countries = cachedFacet.countries;
      totalAll = cachedFacet.totalAll;
    } else {
      const [facetRows, totalRow] = await Promise.all([
        q<Record<string, unknown>>(
          `SELECT country, count(*)::int AS n FROM content
           WHERE content_type = $1 AND country IS NOT NULL
           GROUP BY country ORDER BY n DESC`,
          [contentType]
        ),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content WHERE content_type = $1`, [contentType]),
      ]);
      countries = facetRows.map((r) => ({
        code: String(r.country),
        name: countryName(String(r.country)),
        n: Number(r.n),
      }));
      totalAll = Number(totalRow?.n || 0);
      cacheSet(facetKey, { countries, totalAll }, 600);
    }

    // ---- interogare principală (Faza 3: cache 60s per combinație de filtre) ----
    const listKey = `chan:list:${contentType}:${qRaw}:${country}:${continent}:${limit}:${offset}`;
    const cachedList = cacheGet<{ items: ChannelRow[]; filteredTotal: number }>(listKey);

    let items: ChannelRow[];
    let filteredTotal: number;

    if (cachedList) {
      items = cachedList.items;
      filteredTotal = cachedList.filteredTotal;
    } else {
    const params: unknown[] = [];
    let p = 0;
    const next = (v: unknown) => {
      params.push(v);
      p++;
      return `$${p}`;
    };
    let where = `content_type = ${next(contentType)}`;
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
              COALESCE(meta_quality, CASE WHEN meta ? 'bitrate' THEN concat_ws(' ', meta->>'bitrate', 'kbps') END) AS quality,
              COALESCE(meta_geo, false) AS "geoBlocked",
              COALESCE(meta_not247, false) AS "not247",
              meta->>'codec' AS codec,
              meta->>'bitrate' AS bitrate
       FROM content
       WHERE ${where}
       ORDER BY popularity DESC, title ASC
       LIMIT ${limitPh} OFFSET ${offsetPh}`,
      params
    );

    const ft = qRaw || country || continent
      ? await qOne<{ n: string }>(
          `SELECT count(*)::text AS n FROM content WHERE ${where}`,
          params.slice(0, params.length - 2)
        )
      : null;

    items = rows.map((r) => ({
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
      codec: (r.codec as string) || null,
      bitrate: r.bitrate ? Number(r.bitrate) : null,
    }));
    filteredTotal = ft ? Number(ft.n) : totalAll;
    cacheSet(listKey, { items, filteredTotal }, 60);
    }

    return withCache(
      req,
      {
        ok: true,
        items,
        total: totalAll,
        filteredTotal,
        countries,
        limit,
        offset,
      },
      { sMaxage: 20, swr: 60 },
      { "X-RateLimit-Remaining": String(rl.remaining) }
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// Faza 17 — observabilitate Prometheus pentru channels
export const GET = wrapMetrics("channels", getHandler);
