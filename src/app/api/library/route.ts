import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { createHash } from "node:crypto";
import { authOptions } from "@/lib/auth";
import { searchLibrary, insertContent, recordPlayback, normalizeRo, invalidateSearchCache } from "@/lib/neon-search";
import { q, qOne } from "@/lib/pg";
import { resolveSource, titleFromUrl } from "@/lib/source-resolver";
import { parseSigningConfig } from "@/lib/stream-sign";
import { parseM3U, normalizeM3UInputUrl, type M3UChannel } from "@/lib/m3u-parser";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";
import { withCache } from "@/lib/http-cache";

type Item = Record<string, unknown>;

// ---------- METADATE oEmbed REALE (fără chei, endpoint-uri publice) ----------
// Pentru linkurile încărcate de utilizator din platforme mari, titlul și
// miniatura REALĂ se extrag server-side la salvare — nu ghicim, nu simulăm.
const OEMBED: { re: RegExp; url: (m: RegExpMatchArray) => string; provider: string }[] = [
  {
    re: /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i,
    url: (m) => `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${m[1]}`)}&format=json`,
    provider: "youtube",
  },
  {
    re: /vimeo\.com\/(?:video\/)?(\d+)/i,
    url: (m) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${m[1]}`)}`,
    provider: "vimeo",
  },
  {
    re: /(?:dailymotion\.com\/(?:video\/|embed\/video\/)|dai\.ly\/)([a-z0-9]+)/i,
    url: (m) => `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(`https://www.dailymotion.com/video/${m[1]}`)}&format=json`,
    provider: "dailymotion",
  },
];

async function fetchOEmbed(sourceUrl: string): Promise<{ title?: string; thumbnail?: string } | null> {
  for (const o of OEMBED) {
    const m = sourceUrl.match(o.re);
    if (!m) continue;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(o.url(m), { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) return null;
      const j = (await res.json()) as { title?: string; thumbnail_url?: string };
      return { title: j.title || undefined, thumbnail: j.thumbnail_url || undefined };
    } catch {
      return null; // sandbox/offline — salvăm oricum, cu metadatele userului
    }
  }
  return null;
}

/** Miniatură reală YouTube (fallback rapid, fără rețea). */
function ytThumb(input: string): string | null {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i.exec(input);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

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
                year, rating, popularity, views, (meta ? 'signing') AS signed, 0 AS score
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

  return withCache(req, {
    items: hits.map(toApiItem),
    total: Number(total?.n || 0),
    tookMs,
    facets: facets.map((f) => ({ type: f.content_type, count: f.n })),
  }, { sMaxage: 15, swr: 60 });
}

type LibRow = {
  id: number; externalId: string; title: string; originalTitle: string | null; description: string;
  contentType: string; brand: string | null; category: string | null; continent: string | null;
  country: string | null; provider: string; sourceType: string; sourceUrl: string | null;
  embedCode: string | null; thumbnail: string | null; backdrop: string | null; year: number | null;
  rating: number; popularity: number; views: number; score: number; signed: boolean;
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
    signed: Boolean(r.signed),
  };
}

function toApiItem(h: LibRow) {
  return {
    id: h.id, externalId: h.externalId, title: h.title, originalTitle: h.originalTitle,
    description: h.description, contentType: h.contentType, brand: h.brand, category: h.category,
    continent: h.continent, country: h.country, provider: h.provider, sourceType: h.sourceType,
    sourceUrl: h.sourceUrl, embedCode: h.embedCode, thumbnail: h.thumbnail, backdrop: h.backdrop,
    year: h.year, rating: h.rating, popularity: h.popularity, views: h.views,
    signed: h.signed,
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

  // ---------- ADD: salvare în Neon (singular sau BULK) ----------
  if (action === "add") {
    const session = await getServerSession(authOptions).catch(() => null);
    const userId = session?.user?.email || null;

    // BULK: un element pe linie (URL / iframe / embed) + metadate comune
    const bulkRaw = Array.isArray(body.items) ? (body.items as unknown[]) : null;
    const entries: { input: string; title?: string }[] = bulkRaw
      ? bulkRaw.map((x) =>
          typeof x === "string"
            ? { input: String(x) }
            : { input: String((x as { input?: string }).input || ""), title: (x as { title?: string }).title }
        ).filter((e) => e.input.trim())
      : [{ input: String(body.input || ""), title: body.title ? String(body.title) : undefined }];
    if (entries.length === 0) return NextResponse.json({ error: "empty" }, { status: 400 });

    const contentType = String(body.contentType || "video");
    const brand = body.brand ? String(body.brand) : null;
    const country = body.country ? String(body.country) : null;
    const language = body.language ? String(body.language) : "en";
    const year = body.year ? Number(body.year) : null;
    const posterUrl = body.posterUrl ? String(body.posterUrl) : null;
    const description = body.description ? String(body.description) : "";
    // Faza 10 — configurație semnare stream (token/HMAC/JWT), validată server-side
    const signing = parseSigningConfig(body.signing);
    const genres: string[] = Array.isArray(body.genres)
      ? (body.genres as unknown[]).map(String).filter(Boolean)
      : typeof body.genres === "string"
        ? String(body.genres).split(",").map((g) => g.trim()).filter(Boolean)
        : [];

    const sessionSaved: Awaited<ReturnType<typeof insertContent>>[] = [];
    const duplicates: string[] = [];
    const failed: string[] = [];

    for (const entry of entries.slice(0, 50)) { // max 50/batch — protejează pool-ul
      const input = entry.input.trim();
      const resolved = resolveSource(input, { parent: req.headers.get("host") || "" });
      if (!resolved) { failed.push(input.slice(0, 80)); continue; }

      const refUrl =
        resolved.kind === "html"
          ? ""
          : (resolved as { src?: string; url?: string }).src ||
            (resolved as { url?: string }).url || "";

      // IDEMPOTENT: hash pe sursa normalizată (fără timestamp) →
      // același link adăugat de 2 ori NU se dublează în bibliotecă.
      const normSource = normalizeRo(`${refUrl || input}`).replace(/\s/g, "").toLowerCase();
      const extId = `user:${normSource.slice(0, 120)}`;

      // metadate reale oEmbed (titlu + miniatură) pentru platforme mari
      const oembed = refUrl ? await fetchOEmbed(refUrl) : null;

      const title =
        String(entry.title || body.title || "").trim() ||
        oembed?.title ||
        (refUrl ? titleFromUrl(refUrl) : "") ||
        "Cod embed personalizat";

      const dup = await qOne<{ id: number; title: string }>(
        `SELECT id, title FROM content WHERE external_id = $1 LIMIT 1`, [extId]
      );
      if (dup) { duplicates.push(dup.title); continue; }

      const thumb = posterUrl || oembed?.thumbnail || ytThumb(input) || null;

      const inserted = await insertContent({
        externalId: extId,
        title,
        description: description || `Conținut încărcat de utilizator — ${resolved.providerLabel}.`,
        contentType,
        brand,
        category: contentType,
        country,
        language,
        provider: resolved.provider,
        sourceType: resolved.kind === "html" ? "embed" : resolved.kind,
        sourceUrl: refUrl || (resolved.kind === "unknown" ? (resolved as { url?: string }).url : null),
        embedCode: resolved.kind === "html" ? resolved.html : null,
        thumbnail: thumb,
        year,
        tags: genres.length ? genres : ["adaugat", resolved.provider],
        meta: {
          resolved: resolved.provider, kind: resolved.kind, oembed: oembed ? "hit" : "miss",
          // Faza 10 — configurație semnare server-side (secretul nu pleacă în browser)
          ...(signing ? { signing } : {}),
        },
        createdBy: userId,
      }).catch((e) => {
        console.error("library add:", e);
        return null;
      });

      if (inserted) sessionSaved.push(inserted);
      else failed.push(input.slice(0, 80));
    }

    return NextResponse.json({
      items: sessionSaved
        .map((x) =>
          x
            ? { ...toApiItem(x as unknown as LibRow), signed: Boolean(signing) }
            : x
        )
        .filter(Boolean),
      added: sessionSaved.length,
      duplicates,
      failed,
    });
  }

  // ---------- M3U: import playlist de utilizator (paste text sau URL) ----------
  if (action === "m3u") {
    // operație scumpă → rate limit per IP (5 importuri / minut)
    const rl = rateLimit(`m3u:${clientIp(req)}`, { burst: 5, perMinute: 6 });
    if (!rl.ok) return tooMany(rl);

    const session = await getServerSession(authOptions).catch(() => null);
    const userId = session?.user?.email || null;

    // 1) obține textul M3U: paste direct sau URL descărcat server-side
    let m3uText = typeof body.content === "string" ? body.content : "";
    const srcUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!m3uText && srcUrl) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20_000);
        const res = await fetch(normalizeM3UInputUrl(srcUrl), {
          signal: ctrl.signal,
          cache: "no-store",
          headers: { "User-Agent": "StreamVerse/1.0 (+playlist-import)" },
        });
        clearTimeout(t);
        if (!res.ok) {
          return NextResponse.json(
            { error: "fetch-failed", message: `URL-ul a răspuns ${res.status} — verifică linkul.` },
            { status: 400 }
          );
        }
        const raw = await res.text();
        if (raw.length > 12_000_000) {
          return NextResponse.json({ error: "too-large", message: "Playlist peste 12 MB — împarte-l în mai multe importuri." }, { status: 413 });
        }
        if (!/#EXTM3U|#EXTINF/i.test(raw)) {
          return NextResponse.json(
            { error: "not-m3u", message: "URL-ul nu returnează un playlist M3U (fără #EXTM3U/#EXTINF)." },
            { status: 400 }
          );
        }
        m3uText = raw;
      } catch {
        return NextResponse.json(
          { error: "fetch-failed", message: "Nu am putut descărca playlistul (timeout sau rețea)." },
          { status: 400 }
        );
      }
    }
    if (!m3uText.trim()) return NextResponse.json({ error: "empty", message: "Lipește conținutul M3U sau un URL." }, { status: 400 });

    // 2) parse robust
    const parsed = parseM3U(m3uText);
    if (parsed.channels.length === 0) {
      return NextResponse.json(
        { error: "no-channels", message: parsed.errors.join(" ") || "Playlistul nu conține canale." },
        { status: 400 }
      );
    }
    if (parsed.channels.length > 20_000) {
      return NextResponse.json(
        { error: "too-many", message: `Maxim 20.000 canale per import (primit ${parsed.channels.length}).` },
        { status: 400 }
      );
    }

    let playlistHost = "Playlist utilizator";
    if (srcUrl) {
      try { playlistHost = new URL(normalizeM3UInputUrl(srcUrl)).hostname; } catch { /* keep */ }
    }
    const playlistName = parsed.playlistName || playlistHost;

    // 3) mapare pe rânduri content + dedup intern
    const detectStreamType = (url: string): string => {
      const l = url.toLowerCase();
      if (l.includes(".m3u8")) return "hls";
      if (l.endsWith(".mpd")) return "dash";
      if (l.startsWith("srt://")) return "srt";
      if (l.endsWith(".ts") || l.startsWith("udp://") || l.startsWith("rtp://")) return "ts";
      return "url";
    };
    const countryFromTvgId = (tvgId: string | null): string | null => {
      if (!tvgId) return null;
      const m = /\.([a-z]{2})@/i.exec(tvgId) || /\.([a-z]{2})(?:\.|$)/i.exec(tvgId);
      return m ? m[1].toUpperCase() : null;
    };

    const seen = new Set<string>();
    const rows: (string | number | null)[][] = [];
    let internalDup = 0;

    for (const ch of parsed.channels as M3UChannel[]) {
      const extId = `m3u:${createHash("md5").update(ch.url).digest("hex")}`;
      if (seen.has(extId)) { internalDup++; continue; }
      seen.add(extId);
      const searchText = normalizeRo(
        [ch.name, ch.groups.join(" "), playlistName, ch.isRadio ? "radio live" : "tv live"].join(" ")
      );
      rows.push([
        extId,
        ch.name,
        `Canal din playlistul „${playlistName}"${ch.groups.length ? ` • ${ch.groups.join(", ")}` : ""}.`,
        ch.isRadio ? "radio" : "live_tv",
        ch.groups[0] || null,
        "Global",
        countryFromTvgId(ch.tvgId),
        "ro",
        "m3u",
        detectStreamType(ch.url),
        ch.url,
        ch.logo,
        [...ch.groups, ch.quality, ch.geoBlocked ? "geo-blocked" : null, ch.not247 ? "not-24-7" : null].filter(Boolean),
        searchText,
        JSON.stringify({
          playlistName,
          tvgId: ch.tvgId,
          quality: ch.quality,
          geoBlocked: ch.geoBlocked,
          not247: ch.not247,
          groups: ch.groups,
        }),
        userId,
      ]);
    }

    // 4) dedup vs. DB (pre-SELECT pe indexul external_id) + INSERT multi-VALUES pe chunk-uri
    const CHUNK = 300;
    let added = 0;
    let dbDup = 0;
    const groupCount = new Map<string, number>();

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const ids = chunk.map((r) => String(r[0]));
      const existing = await q<{ external_id: string }>(
        `SELECT external_id FROM content WHERE external_id = ANY($1::text[])`,
        [ids]
      ).catch(() => [] as { external_id: string }[]);
      const existingSet = new Set(existing.map((e) => e.external_id));
      dbDup += existingSet.size;

      const fresh = existingSet.size ? chunk.filter((r) => !existingSet.has(String(r[0]))) : chunk;
      if (fresh.length === 0) continue;

      const values: string[] = [];
      const params: unknown[] = [];
      let p = 0;
      for (const r of fresh) {
        const ph = r.map(() => { p++; return `$${p}`; });
        values.push(`(${ph.join(",")})`);
        params.push(...r);
      }
      const res = await q<{ id: number }>(
        `INSERT INTO content
           (external_id, title, description, content_type, category, continent, country, language,
            provider, source_type, source_url, thumbnail, tags, search_text, meta, created_by)
         VALUES ${values.join(",")}
         RETURNING id`,
        params
      ).catch(() => [] as { id: number }[]);
      added += res.length;
    }

    // 5) facet grupuri (pentru raportul din UI)
    for (const ch of parsed.channels) {
      for (const g of ch.groups) groupCount.set(g, (groupCount.get(g) || 0) + 1);
    }
    const topGroups = [...groupCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([group, n]) => ({ group, n }));

    // 6) invalidare cache căutare (L1+L2) — noile canale apar instant
    if (added > 0) invalidateSearchCache();

    return NextResponse.json({
      ok: true,
      playlistName,
      parsed: parsed.channels.length,
      parsedRadio: parsed.channels.filter((c) => c.isRadio).length,
      added,
      duplicates: internalDup + dbDup,
      skipped: parsed.skipped,
      errors: parsed.errors,
      topGroups,
    });
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
