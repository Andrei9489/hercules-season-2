// ============================================================
// Faza 5 — Ingest iTunes RSS charts (16 storefront-uri de țări):
//   • topsongs       → melodii cu preview audio REAL (m4a 30s)
//   • topmusicvideos → videoclipuri muzicale cu preview video REAL
//   • toppodcasts    → podcasturi (metadata + summary, sursă la detail)
// Sursă 100% reală Apple iTunes Store, artwork HD, genuri, date.
// Rulează: bun scripts/ingest-itunes-v5.ts (idempotent)
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import dns from "node:dns";

try { dns.setDefaultResultOrder("ipv4first"); } catch { /* noop */ }
neonConfig.webSocketConstructor = WebSocket;
const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: url });

type Row = {
  external_id: string; title: string; original_title?: string; description: string;
  content_type: string; brand?: string; category?: string; continent?: string; country?: string;
  language?: string; provider: string; source_type: string; source_url?: string; embed_code?: string;
  thumbnail?: string; backdrop?: string; year?: number; rating?: number; popularity?: number;
  tags: string[]; meta?: Record<string, unknown>;
};

// storefront → [continent, limba, nume țară RO]
const STORES: [string, string, string, string][] = [
  ["ro", "Europa", "ro", "România"], ["us", "America de Nord", "en", "SUA"],
  ["gb", "Europa", "en", "Marea Britanie"], ["de", "Europa", "de", "Germania"],
  ["fr", "Europa", "fr", "Franța"], ["es", "Europa", "es", "Spania"],
  ["it", "Europa", "it", "Italia"], ["nl", "Europa", "nl", "Olanda"],
  ["pl", "Europa", "pl", "Polonia"], ["tr", "Asia", "tr", "Turcia"],
  ["jp", "Asia", "ja", "Japonia"], ["in", "Asia", "hi", "India"],
  ["br", "America de Sud", "pt", "Brazilia"], ["mx", "America de Nord", "es", "Mexic"],
  ["au", "Oceania", "en", "Australia"], ["ca", "America de Nord", "en", "Canada"],
];

function normalizeRo(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

type Entry = Record<string, {
  label?: string;
  attributes?: { href?: string; rel?: string; type?: string; "im:id"?: string; height?: string; title?: string; "im:duration"?: { label?: string } };
}>;

async function fetchJson<T>(u: string, retries = 2): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15_000);
      const res = await fetch(u, { signal: ctl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch {
      if (i < retries) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  return null;
}

function imgBig(e: Entry): string | undefined {
  const imgs = e["im:image"];
  if (!Array.isArray(imgs) || imgs.length === 0) return undefined;
  const last = imgs[imgs.length - 1]?.label || "";
  return last.replace(/\/\d+x\d+bb\.png/, "/600x600bb.png") || undefined;
}

function previewUrl(e: Entry): string | undefined {
  const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
  for (const l of links) {
    const a = l?.attributes;
    if (a?.rel === "enclosure" && a.href) return a.href;
  }
  return undefined;
}

const rows: Row[] = [];
let fetched = 0, fetchErrs = 0;

function mapEntry(e: Entry, kind: string, store: string, cont: string, lang: string, cname: string, rank: number): void {
  const id = e.id?.attributes?.["im:id"] || e.id?.label?.split("/id")?.[1]?.replace(/\?.*/, "");
  const title = e["im:name"]?.label || e.title?.label;
  if (!id || !title) return;
  const artist = e["im:artist"]?.label || "";
  const genre = e.category?.attributes?.label || "";
  const date = e["im:releaseDate"]?.label || "";
  const year = date ? Number(date.slice(0, 4)) : undefined;
  const thumb = imgBig(e);
  const pop = 5100 - rank * 50;

  if (kind === "song") {
    const src = previewUrl(e);
    rows.push({
      external_id: `itunes:${store}:song:${id}`, title: artist ? `${title} — ${artist}` : title,
      original_title: title, description: `${artist || "Artist necunoscut"} • ${genre || "Muzică"} • Top ${rank} iTunes ${cname}`,
      content_type: "music", category: "muzica", continent: cont, country: store, language: lang,
      provider: "itunes", source_type: src ? "audio" : "none", source_url: src,
      thumbnail: thumb, year, rating: 0, popularity: pop,
      tags: ["muzica", "top-itunes", store, genre.toLowerCase()],
      meta: { itunesId: id, artist, genre, chart: `topsongs-${store}`, rank },
    });
  } else if (kind === "mv") {
    const src = previewUrl(e);
    rows.push({
      external_id: `itunes:${store}:mv:${id}`, title: artist ? `${title} — ${artist}` : title,
      original_title: title, description: `Videoclip muzical • ${artist || ""} ${genre ? "• " + genre : ""} • Top ${rank} iTunes ${cname}`,
      content_type: "music", category: "videoclip", continent: cont, country: store, language: lang,
      provider: "itunes", source_type: src ? "video" : "none", source_url: src,
      thumbnail: thumb, year, rating: 0, popularity: pop,
      tags: ["videoclip", "muzica", store, genre.toLowerCase()],
      meta: { itunesId: id, artist, genre, chart: `topmusicvideos-${store}`, rank },
    });
  } else {
    // podcast
    const summary = e.summary?.label || "";
    rows.push({
      external_id: `itunes:${store}:podcast:${id}`, title,
      description: summary.slice(0, 500) || `${artist || ""} • ${genre || "Podcast"} • Top ${rank} iTunes ${cname}`,
      content_type: "podcast", category: "podcast", continent: cont, country: store, language: lang,
      provider: "itunes", source_type: "none",
      thumbnail: thumb, year, rating: 0, popularity: pop,
      tags: ["podcast", genre.toLowerCase(), store],
      meta: { itunesId: id, artist, genre, chart: `toppodcasts-${store}`, rank },
    });
  }
}

// ---------- JOB-URI: 16 storefront-uri × 3 charturi ----------
type Task = { store: string; kind: string; cont: string; lang: string; cname: string };
const tasks: Task[] = [];
for (const [store, cont, lang, cname] of STORES) {
  tasks.push({ store, kind: "song", cont, lang, cname });
  tasks.push({ store, kind: "mv", cont, lang, cname });
  tasks.push({ store, kind: "podcast", cont, lang, cname });
}

const CONCURRENCY = 6;
async function worker(id: number): Promise<void> {
  while (tasks.length > 0) {
    const t = tasks.shift();
    if (!t) break;
    const chart = t.kind === "song" ? "topsongs" : t.kind === "mv" ? "topmusicvideos" : "toppodcasts";
    const u = `https://itunes.apple.com/${t.store}/rss/${chart}/limit=100/json`;
    const data = await fetchJson<{ feed?: { entry?: Entry[] } }>(u);
    const entries = data?.feed?.entry || [];
    fetched += entries.length;
    entries.forEach((e, i) => mapEntry(e, t.kind, t.store, t.cont, t.lang, t.cname, i + 1));
    if (!data) fetchErrs++;
  }
}

async function main() {
  console.log(`Ingest iTunes: 16 storefront-uri × 3 charturi • ${tasks.length} cereri (x${CONCURRENCY})`);
  const tFetch0 = Date.now();
  const totalTasks = tasks.length;
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const fetchMs = Date.now() - tFetch0;

  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.external_id) ? false : (seen.add(r.external_id), true)));
  const existing = await pool.query(`SELECT external_id FROM content`);
  const have = new Set((existing.rows as { external_id: string }[]).map((e) => e.external_id));
  const toInsert = unique.filter((r) => !have.has(r.external_id));

  console.log(`Fetch: ${fetched} itemi din ${totalTasks} cereri în ${(fetchMs / 1000).toFixed(1)}s (${(totalTasks / (fetchMs / 1000)).toFixed(1)} req/s) • erori: ${fetchErrs}`);
  console.log(`Colectate: ${rows.length} • unice: ${unique.length} • noi de inserat: ${toInsert.length}`);

  const COLS = 22;
  const SQLBASE = `INSERT INTO content
    (external_id, title, original_title, description, content_type, brand, category, continent, country, language, provider, source_type, source_url, embed_code, thumbnail, backdrop, year, rating, popularity, tags, search_text, meta) VALUES `;

  const chunks: Row[][] = [];
  for (let i = 0; i < toInsert.length; i += 50) chunks.push(toInsert.slice(i, i + 50));

  let ins = 0, errs = 0;
  const tIns0 = Date.now();
  async function insertWorker(): Promise<void> {
    while (chunks.length > 0) {
      const chunk = chunks.shift();
      if (!chunk) break;
      const params: unknown[] = [];
      const tuples = chunk.map((r, i) => {
        const st = normalizeRo([
          r.title, r.original_title || "", r.description,
          (r.tags || []).join(" "), r.brand || "", r.content_type, r.category || "", r.provider,
        ].join(" "));
        const vals = [
          r.external_id, r.title, r.original_title || null, r.description || "",
          r.content_type, r.brand || null, r.category || null, r.continent || "Global",
          r.country || null, r.language || "en", r.provider, r.source_type,
          r.source_url || null, r.embed_code || null, r.thumbnail || null, r.backdrop || null,
          r.year || null, r.rating || 0, r.popularity || 0, r.tags || [], st, JSON.stringify(r.meta || {}),
        ];
        vals.forEach((v) => params.push(v));
        const ph = Array.from({ length: COLS }, (_, c) => `$${i * COLS + c + 1}`).join(",");
        return `(${ph})`;
      });
      try {
        await pool.query(SQLBASE + tuples.join(","), params);
        ins += chunk.length;
      } catch {
        for (const r of chunk) {
          const st = normalizeRo([
            r.title, r.original_title || "", r.description,
            (r.tags || []).join(" "), r.brand || "", r.content_type, r.category || "", r.provider,
          ].join(" "));
          try {
            await pool.query(SQLBASE + "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)", [
              r.external_id, r.title, r.original_title || null, r.description || "",
              r.content_type, r.brand || null, r.category || null, r.continent || "Global",
              r.country || null, r.language || "en", r.provider, r.source_type,
              r.source_url || null, r.embed_code || null, r.thumbnail || null, r.backdrop || null,
              r.year || null, r.rating || 0, r.popularity || 0, r.tags || [], st, JSON.stringify(r.meta || {}),
            ]);
            ins++;
          } catch { errs++; }
        }
      }
    }
  }
  await Promise.all([insertWorker(), insertWorker()]);
  const insMs = Date.now() - tIns0;

  try {
    await pool.query(`ANALYZE content`);
    await pool.query(`DELETE FROM search_cache WHERE key LIKE 'sl:%' OR key LIKE 'sug:%' OR key LIKE 'trend:%'`);
    console.log(`ANALYZE + invalidare L2 OK`);
  } catch (e) { console.log(`Post-ingest warn: ${String(e).slice(0, 120)}`); }

  const cnt = await pool.query(
    `SELECT count(*)::int AS total, count(DISTINCT content_type)::int AS types,
            count(DISTINCT provider)::int AS providers, count(DISTINCT country)::int AS countries FROM content`
  );
  const byType = await pool.query(`SELECT content_type, count(*)::int AS n FROM content GROUP BY content_type ORDER BY n DESC`);
  const src = await pool.query(`SELECT source_type, count(*)::int AS n FROM content GROUP BY source_type ORDER BY n DESC`);
  const totalSec = (Date.now() - t0ms()) / 1000;
  console.log(`\nIngest complet în ${totalSec.toFixed(1)}s: ${ins} inserate (${(ins / (insMs / 1000)).toFixed(0)} rows/s insert) • ${errs} erori`);
  console.log(`Total bibliotecă Neon: ${cnt.rows[0].total} conținuturi • ${cnt.rows[0].types} tipuri • ${cnt.rows[0].providers} provideri • ${cnt.rows[0].countries} țări`);
  console.log(byType.rows.map((r: { content_type: string; n: number }) => `${r.content_type}:${r.n}`).join(" | "));
  console.log("SURSE:", src.rows.map((r: { source_type: string; n: number }) => `${r.source_type}:${r.n}`).join(" | "));

  await pool.end();
}

function t0ms(): number { return (globalThis as { __t0?: number }).__t0 ?? Date.now(); }
(globalThis as { __t0?: number }).__t0 = Date.now();

main().catch((e) => { console.error(e); process.exit(1); });
