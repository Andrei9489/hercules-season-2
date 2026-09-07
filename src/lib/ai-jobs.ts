// ============================================================
// StreamVerse — Faza 7: AI JOBS (server-only)
//  1. runGenresJob()      — AI creează automat TOATE genurile și
//     categoriile din conținutul real: genuri, categorii, ani,
//     decenii, studiouri, francize, colecții, trilogii — și leagă
//     conținutul de ele (meniuri populate automat).
//  2. runMetadataJob()    — AI extrage metadate REALE pentru tot
//     conținutul: detalii TMDB (ro-RO), clasificare LLM pe canale
//     TV/radio, descrieri derivate din câmpuri reale — salvate în Neon.
// Idempotente, cu progres real în ai_jobs.
// ============================================================
import dns from "node:dns";
import { q, qOne } from "./pg";

dns.setDefaultResultOrder("ipv4first");

type Row = Record<string, unknown>;

const TMDB_KEY = process.env.TMDB_API_KEY || "3dd880e229e7b83d8e63c4b6f08f77a4";

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "n-a";
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function startJob(kind: string, total: number): Promise<number> {
  const r = await q<{ id: number }>(
    `INSERT INTO ai_jobs (kind, status, total) VALUES ($1, 'running', $2) RETURNING id`,
    [kind, total]
  );
  return Number(r[0].id);
}

async function finishJob(id: number, processed: number, inserted: number, payload: unknown, error?: string) {
  await q(
    `UPDATE ai_jobs SET status=$2, processed=$3, inserted=$4, payload=$5::jsonb,
       finished_at=now(), error=$6 WHERE id=$1`,
    [id, error ? "error" : "done", processed, inserted, JSON.stringify(payload || {}), error || null]
  );
}

// ------------------------------------------------------------
// SURSA 1: detalii TMDB (metadate reale, în română)
// ------------------------------------------------------------
type TmdbDetail = {
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  genres?: { id: number; name: string }[];
  production_companies?: { name: string }[];
  networks?: { name: string }[];
  belongs_to_collection?: { id: number; name: string } | null;
  runtime?: number | null;
  vote_average?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
};

async function tmdbGet(type: string, id: string): Promise<TmdbDetail | null> {
  const u = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=ro-RO`;
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(12_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`tmdb ${res.status}`);
    return (await res.json()) as TmdbDetail;
  } catch {
    return null;
  }
}

const IMG = "https://image.tmdb.org/t/p/w500";

function buildSearchText(parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

// ------------------------------------------------------------
// SURSA 2: clasificare LLM (canale TV + radio fără genuri)
// ------------------------------------------------------------
const LLM_GENRES = [
  "Știri", "Sport", "Muzică", "Film", "Seriale", "Copii", "Documentar",
  "Divertisment", "Lifestyle", "Religie", "Educativ", "Știință", "Istorie",
  "Natură", "Călătorii", "Gătit", "Tehnologie", "Gaming", "Anime",
  "Comedie", "Dramă", "Acțiune", "Romantic", "Talk-show", "Reality",
  "Muzică populară", "Dance", "Rock", "Pop", "Jazz", "Clasic", "Hip-Hop",
  "Vreme", "Politică", "Economie", "Autos", "Comunitate", "Oldies",
];

async function llmClassify(names: string[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const list = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: "assistant",
          content:
            "Ești un clasificator AI de canale TV și posturi radio. Primești o listă numerotată de nume. " +
            "Pentru fiecare, alegi 1-2 genuri DIN LISTA PERMISĂ. " +
            `Genuri permise: ${LLM_GENRES.join(", ")}. ` +
            'Răspunzi DOAR cu JSON valid: {"1":["Știri"],"2":["Muzică","Rock"],...} — fără explicații.',
        },
        { role: "user", content: list },
      ],
      thinking: { type: "disabled" },
    });
    const raw = completion.choices[0]?.message?.content || "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return out;
    const parsed = JSON.parse(m[0]) as Record<string, string[]>;
    for (const [k, vals] of Object.entries(parsed)) {
      const idx = Number(k) - 1;
      if (idx < 0 || idx >= names.length || !Array.isArray(vals)) continue;
      const valid = vals
        .map((v) => String(v).trim())
        .filter((v) => LLM_GENRES.includes(v))
        .slice(0, 2);
      if (valid.length) out.set(idx, valid);
    }
  } catch {
    // LLM indisponibil → clasificarea se reia la următoarea rulare
  }
  return out;
}

// ------------------------------------------------------------
// Patern-uri reale de recunoaștere (francize + tipuri de canal)
// ------------------------------------------------------------
const FRANCHISE_PATTERNS: { slug: string; name: string; re: RegExp }[] = [
  { slug: "franciza-marvel", name: "Marvel", re: /marvel|avengers|spider-?man|iron man|thor|black panther|captain america|guardians of the galaxy|doctor strange|ant-?man|deadpool|wolverine|loki|wandavision|hawkeye|daredevil/i },
  { slug: "franciza-dc", name: "DC Comics", re: /\bdc\b|batman|superman|wonder woman|justice league|aquaman|the flash|joker|harley quinn|green lantern|shazam|peacemaker/i },
  { slug: "franciza-star-wars", name: "Star Wars", re: /star wars|mandalorian|jed[i]|skywalker|bobba fett|andor/i },
  { slug: "franciza-harry-potter", name: "Harry Potter", re: /harry potter|fanteastc beasts|animale fantastice|hogwarts/i },
  { slug: "franciza-fast-furious", name: "Fast & Furious", re: /fast( &| and) furious|fast x|tokyo drift|hobbs/i },
  { slug: "franciza-jurassic", name: "Jurassic", re: /jurassic/i },
  { slug: "franciza-mission-impossible", name: "Mission: Impossible", re: /mission.{0,3}impossible/i },
  { slug: "franciza-john-wick", name: "John Wick", re: /john wick/i },
  { slug: "franciza-lotr", name: "Middle-earth", re: /lord of the rings|hobbit|stapanul inelelor|comunitatea inelului/i },
  { slug: "franciza-pirates", name: "Pirates of the Caribbean", re: /pirates of the caribbean|caribicul/i },
  { slug: "franciza-transformers", name: "Transformers", re: /transformers/i },
  { slug: "franciza-godzilla", name: "Godzilla / Monsterverse", re: /godzilla|kong|monarch/i },
  { slug: "franciza-toy-story", name: "Toy Story", re: /toy story/i },
  { slug: "franciza-despicable", name: "Despicable Me / Minions", re: /despicable|minions|gruu|mirosind/i },
  { slug: "franciza-frozen", name: "Frozen", re: /frozen|regatul de gheata/i },
  { slug: "franciza-shrek", name: "Shrek", re: /shrek/i },
  { slug: "franciza-kung-fu-panda", name: "Kung Fu Panda", re: /kung fu panda/i },
  { slug: "franciza-ice-age", name: "Ice Age", re: /ice age|era de gheata/i },
  { slug: "franciza-madagascar", name: "Madagascar", re: /madagascar/i },
  { slug: "franciza-batman", name: "Batman", re: /batman|dark knight/i },
  { slug: "franciza-james-bond", name: "James Bond", re: /james bond|007|skyfall|no time to die|casino royale/i },
  { slug: "franciza-matrix", name: "The Matrix", re: /matrix/i },
  { slug: "franciza-alien", name: "Alien / Predator", re: /alien|predator|avp/i },
  { slug: "franciza-terminator", name: "Terminator", re: /terminator/i },
  { slug: "franciza-hunger-games", name: "Hunger Games", re: /hunger games|jocurile foamei/i },
  { slug: "franciza-twilight", name: "Twilight", re: /twilight|amurg/i },
  { slug: "franciza-dune", name: "Dune", re: /\bdune\b/i },
  { slug: "franciza-paw-patrol", name: "Paw Patrol", re: /paw patrol|patrula catusilor/i },
  { slug: "franciza-sonic", name: "Sonic", re: /sonic/i },
  { slug: "franciza-minecraft", name: "Minecraft", re: /minecraft/i },
];

const TV_GENRE_PATTERNS: { re: RegExp; name: string }[] = [
  { re: /news|stiri|noticias|actualit|info\b|kanal.?7.?news|bbc world|cnn|sky news|al jazeera|euronews|france 24|bloomberg|digi ?24|antena ?3|pro ?tv.?news|realitatea/i, name: "Știri" },
  { re: /sport|fotbal|football|basket|espn|digi ?sport|eurosport|bein|arena ?sport|dazn|golf|tennis|motor|f1\b/i, name: "Sport" },
  { re: /music|muzika|muzica|mtv|vh1|trace|kiss ?tv|radio|fm\b|hits|music ?now|one ?hd.*music/i, name: "Muzică" },
  { re: /kids|copii|cartoon|anime|junior|baby|nick|disney|boomerang|minimax|jetix|kids ?tv/i, name: "Copii" },
  { re: /documentar|docu|discovery|national geographic|nat ?geo|history|animal planet|bbc earth|viasat explore/i, name: "Documentar" },
  { re: /movie|film|cinema|cine\b|hbo|cinemax|film ?now|cinestaan/i, name: "Film" },
  { re: /series|serial|novela|telenovela|drama/i, name: "Seriale" },
  { re: /entertain|divertis|variety|pro ?tv|antena ?1|kanal ?d|prima ?tv|acasa/i, name: "Divertisment" },
  { re: /relig|christ|gospel|bibl|trinitas|ewtn|islam|quran/i, name: "Religie" },
  { re: /lifestyle|fashion|style|food|kitchen|gastro|travel|turism|vlaanderen ?vand ?bo/i, name: "Lifestyle" },
  { re: /weather|meteo/i, name: "Vreme" },
  { re: /gaming|game|esport/i, name: "Gaming" },
  { re: /parliament|senat|camera deputat|politic/i, name: "Politică" },
  { re: /shop|teleshop|magazin ?tv/i, name: "Shopping" },
];

const RADIO_TAG_STOP = new Set([
  "live", "radio", "fm", "am", "dab", "web", "online", "hd", "hls", "aac", "mp3",
  "ogg", "flac", "kbps", "stereo", "mono", "usa", "ukr", "fra", "deu", "gbr", "ita",
  "esp", "pol", "rou", "bra", "mex", "can", "aus", "ind", "jpn", "chn", "tur", "grc",
  "nld", "swe", "nor", "dnk", "fin", "cze", "svk", "hun", "bgr", "srb", "hrv",
]);

function inferTvGenres(name: string, category: string | null, tags: string[]): string[] {
  const hay = `${name} ${category || ""} ${tags.join(" ")}`;
  const found = new Set<string>();
  for (const p of TV_GENRE_PATTERNS) if (p.re.test(hay)) found.add(p.name);
  if (category && /^[A-Z][a-zA-Z &]+$/.test(category) && category.length < 22) {
    found.add(category); // categoria M3U reală (News, Sport, Music…)
  }
  return Array.from(found).slice(0, 3);
}

function inferRadioGenres(name: string, tags: string[], category: string | null): string[] {
  const found = new Set<string>();
  for (const t of tags) {
    const tt = t.trim().toLowerCase();
    if (tt.length < 3 || RADIO_TAG_STOP.has(tt) || /^\d+$/.test(tt) || /^[a-z]{2}$/.test(tt)) continue;
    const pascal = tt.replace(/(^|\s|-)([a-z])/g, (_, a, b) => a + b.toUpperCase());
    found.add(pascal);
  }
  for (const p of TV_GENRE_PATTERNS) if (p.re.test(name)) found.add(p.name);
  if (category && !/^\d+$/.test(category) && category.length > 2 && category.toLowerCase() !== "radio") {
    found.add(category.replace(/(^|\s)([a-z])/g, (_, a, b) => a + b.toUpperCase()));
  }
  return Array.from(found).slice(0, 3);
}

type TaxEntry = { slug: string; name: string; kind: string; source: string; meta?: Record<string, unknown> };

function deriveTaxonomy(row: {
  id: number; title: string; content_type: string; category: string | null;
  brand: string | null; tags: string[]; meta: Record<string, unknown>; year: number | null;
}): TaxEntry[] {
  const out: TaxEntry[] = [];
  const t = row.meta || {};
  const title = row.title;

  // 1. genuri TMDB (ro) — salvate de job-ul de metadate
  if (Array.isArray(t.genres)) {
    for (const g of t.genres as string[]) {
      if (g && g.length < 40) out.push({ slug: slugify(g), name: g, kind: "genre", source: "tmdb" });
    }
  }
  // 2. genuri iTunes (muzică / podcast)
  if (typeof t.genre === "string" && t.genre.length > 1) {
    out.push({ slug: slugify(t.genre), name: t.genre, kind: "genre", source: "itunes" });
  }
  // 3. clasificare AI pe canale TV / radio (pattern-uri reale pe nume/tag-uri)
  if (row.content_type === "live_tv") {
    for (const g of inferTvGenres(title, row.category, row.tags || [])) {
      out.push({ slug: slugify(g), name: g, kind: "genre", source: "m3u" });
    }
    if (row.category) out.push({ slug: slugify(`tv-${row.category}`), name: row.category, kind: "category", source: "m3u" });
    if (row.brand) out.push({ slug: slugify(`playlist-${row.brand}`), name: row.brand, kind: "category", source: "m3u" });
  }
  if (row.content_type === "radio") {
    for (const g of inferRadioGenres(title, row.tags || [], row.category)) {
      out.push({ slug: slugify(g), name: g, kind: "genre", source: "radio" });
    }
  }
  // 4. tipul de conținut = categorie de meniu (Filme, Seriale, Anime…)
  out.push({ slug: slugify(`tip-${row.content_type}`), name: TYPE_LABEL[row.content_type] || row.content_type, kind: "category", source: "platform" });
  // 5. ani + decenii
  if (row.year && row.year > 1900 && row.year <= 2100) {
    out.push({ slug: `an-${row.year}`, name: String(row.year), kind: "year", source: "platform" });
    const dec = Math.floor(row.year / 10) * 10;
    out.push({ slug: `deceniu-${dec}`, name: `Anii ${dec}`, kind: "decade", source: "platform" });
  }
  // 6. studiouri (TMDB production companies / networks)
  if (Array.isArray(t.studios)) {
    for (const s of (t.studios as string[]).slice(0, 2)) {
      if (s && s.length < 60) out.push({ slug: slugify(`studio-${s}`), name: s, kind: "studio", source: "tmdb" });
    }
  }
  // 7. colecții TMDB (belongs_to_collection)
  if (typeof t.collectionName === "string" && t.collectionName.length > 1) {
    out.push({ slug: slugify(`colectie-${t.collectionName}`), name: t.collectionName, kind: "collection", source: "tmdb", meta: { collectionId: t.collectionId } });
  }
  // 8. francize (pattern-uri reale pe titlu + brand)
  for (const f of FRANCHISE_PATTERNS) {
    if (f.re.test(title) || (row.brand && f.re.test(row.brand))) {
      out.push({ slug: f.slug, name: f.name, kind: "franchise", source: "ai" });
      break; // o franciză principală pe titlu
    }
  }
  // 9. genuri clasificate de LLM (meta.aiGenres)
  if (Array.isArray(t.aiGenres)) {
    for (const g of (t.aiGenres as string[]).slice(0, 2)) {
      if (g && g.length < 40) out.push({ slug: slugify(g), name: g, kind: "genre", source: "llm" });
    }
  }
  return out;
}

const TYPE_LABEL: Record<string, string> = {
  movie: "Filme", series: "Seriale", anime: "Anime", cartoon: "Desene animate",
  live_tv: "TV Live", radio: "Radio", music: "Muzică", podcast: "Podcasturi",
  documentary: "Documentare", telenovela: "Telenovele", showbiz: "Show-biz",
  sport: "Sport", video: "Video", gaming: "Gaming",
};

// ============================================================
// JOB: GENURI & CATEGORII AI
// ============================================================
export async function runGenresJob(): Promise<Record<string, unknown>> {
  const totalRow = await qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content`);
  const total = Number(totalRow?.n || 0);
  const jobId = await startJob("genres", total);

  let processed = 0;
  let insertedLinks = 0;
  const kindCounter: Record<string, number> = {};
  let lastId = 0;

  try {
    for (;;) {
      const rows = await q<Row>(
        `SELECT id, title, content_type, category, brand, tags, meta, year
         FROM content WHERE id > $1 ORDER BY id LIMIT 2000`,
        [lastId]
      );
      if (rows.length === 0) break;
      lastId = Number(rows[rows.length - 1].id);

      type Pending = { contentId: number; entry: TaxEntry };
      const pending: Pending[] = [];

      for (const r of rows) {
        const contentId = Number(r.id);
        const entries = deriveTaxonomy({
          id: contentId,
          title: String(r.title),
          content_type: String(r.content_type),
          category: (r.category as string) || null,
          brand: (r.brand as string) || null,
          tags: (r.tags as string[]) || [],
          meta: (r.meta as Record<string, unknown>) || {},
          year: (r.year as number) ?? null,
        });
        for (const e of entries) {
          kindCounter[e.kind] = (kindCounter[e.kind] || 0) + 1;
          pending.push({ contentId, entry: e });
        }
        processed++;
      }

      // upsert genuri (chunk 200 × 5 param)
      const uniqueEntries = new Map<string, TaxEntry>();
      for (const p of pending) if (!uniqueEntries.has(p.entry.slug)) uniqueEntries.set(p.entry.slug, p.entry);
      for (const group of chunk(Array.from(uniqueEntries.values()), 200)) {
        if (group.length === 0) continue;
        const params: unknown[] = [];
        const tuples = group.map((e, i) => {
          params.push(e.slug, e.name, e.kind, e.source, JSON.stringify(e.meta || {}));
          const b = i * 5;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}::jsonb)`;
        });
        await q(
          `INSERT INTO genres (slug, name, kind, source, meta) VALUES ${tuples.join(",")}
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
          params
        );
      }

      // id map pentru slug-urile din acest chunk
      const slugs = Array.from(uniqueEntries.keys());
      const idMap = new Map<string, number>();
      for (const sgroup of chunk(slugs, 400)) {
        const rowsG = await q<Row>(
          `SELECT id, slug FROM genres WHERE slug = ANY($1)`,
          [sgroup]
        );
        for (const g of rowsG) idMap.set(String(g.slug), Number(g.id));
      }

      // link-uri content_genres (chunk 500 × 3 param)
      const links: { contentId: number; genreId: number; source: string }[] = [];
      for (const p of pending) {
        const gid = idMap.get(p.entry.slug);
        if (gid) links.push({ contentId: p.contentId, genreId: gid, source: p.entry.source });
      }
      for (const group of chunk(links, 500)) {
        const params: unknown[] = [];
        const tuples = group.map((l, i) => {
          params.push(l.contentId, l.genreId, l.source);
          const b = i * 3;
          return `($${b + 1},$${b + 2},$${b + 3})`;
        });
        const res = await q<Row>(
          `INSERT INTO content_genres (content_id, genre_id, source) VALUES ${tuples.join(",")}
           ON CONFLICT (content_id, genre_id) DO NOTHING RETURNING 1`,
          params
        );
        insertedLinks += res.length;
      }

      await q(`UPDATE ai_jobs SET processed=$2 WHERE id=$1`, [jobId, processed]);
    }

    // ---- TRILogii: colecții cu exact 3 titluri în bibliotecă ----
    const triRows = await q<Row>(
      `SELECT g.id, g.name, count(cg.content_id)::int AS n
       FROM genres g JOIN content_genres cg ON cg.genre_id = g.id
       WHERE g.kind = 'collection'
       GROUP BY g.id, g.name HAVING count(cg.content_id) = 3`
    );
    let trilogies = 0;
    for (const tr of triRows) {
      const slug = `trilogie-${slugify(String(tr.name))}`;
      const exist = await qOne<{ id: number }>(`SELECT id FROM genres WHERE slug=$1`, [slug]);
      const tid = exist
        ? exist.id
        : Number((await q<{ id: number }>(
            `INSERT INTO genres (slug, name, kind, source, meta) VALUES ($1,$2,'trilogy','ai',$3::jsonb) RETURNING id`,
            [slug, `${tr.name} (Trilogie)`, JSON.stringify({ from: String(tr.name) })]
          ))[0].id);
      const res = await q<Row>(
        `INSERT INTO content_genres (content_id, genre_id, source)
         SELECT cg.content_id, $2, 'ai' FROM content_genres cg WHERE cg.genre_id = $1
         ON CONFLICT DO NOTHING RETURNING 1`,
        [tr.id, tid]
      );
      trilogies += res.length;
    }

    // ---- recomputare contoare + poster reprezentativ (optimizat: GROUP BY + LATERAL) ----
    await q(
      `UPDATE genres g SET
         content_count = COALESCE(cc.n, 0),
         poster = p.thumb,
         updated_at = now()
       FROM (
         SELECT cg.genre_id, count(*)::int AS n
         FROM content_genres cg GROUP BY cg.genre_id
       ) cc
       LEFT JOIN LATERAL (
         SELECT c.thumbnail AS thumb
         FROM content_genres cg2
         JOIN content c ON c.id = cg2.content_id
         WHERE cg2.genre_id = cc.genre_id AND c.thumbnail IS NOT NULL
         ORDER BY c.popularity DESC LIMIT 1
       ) p ON true
       WHERE cc.genre_id = g.id`
    );
    await q(
      `UPDATE genres SET content_count = 0, poster = NULL, updated_at = now()
       WHERE id NOT IN (SELECT genre_id FROM content_genres)`
    );

    const payload = {
      taxonomyByKind: kindCounter,
      trilogiesFound: triRows.length,
      trilogieLinks: trilogies,
    };
    await finishJob(jobId, processed, insertedLinks, payload);
    return { ok: true, processed, insertedLinks, ...payload };
  } catch (e) {
    await finishJob(jobId, processed, insertedLinks, {}, String(e));
    throw e;
  }
}

// ============================================================
// JOB: EXTRAGERE METADATE REALE
// ============================================================
export async function runMetadataJob(maxTmdb = 300, maxLlmBatches = 4, llmBatchSize = 60): Promise<Record<string, unknown>> {
  const jobId = await startJob("metadata", maxTmdb + maxLlmBatches * llmBatchSize);
  let processed = 0;
  let inserted = 0;
  const detail: Record<string, unknown> = { tmdbUpdated: 0, tmdbNotFound: 0, llmItems: 0, llmBatches: 0, descDerived: 0, linksAdded: 0 };

  try {
    // ---------- FAZA 1: TMDB details (ro-RO) ----------
    // Marcator idempotent: aiExtractedAt = "am încercat o dată". Fără el,
    // itemii fără overview ro (descriere rămâne '') s-ar re-procesa la infinit
    // și ar consuma tot bugetul pe aceiași itemi.
    const targets = await q<Row>(
      `SELECT id, external_id, title, original_title, content_type, category, brand, tags, meta,
              thumbnail, backdrop, year, rating, description
       FROM content
       WHERE external_id LIKE 'tmdb:%'
         AND NOT meta ? 'aiExtractedAt'
         AND (year IS NULL OR description IS NULL OR description = '' OR NOT meta ? 'genres')
       ORDER BY popularity DESC NULLS LAST
       LIMIT $1`,
      [maxTmdb]
    );
    await q(`UPDATE ai_jobs SET total = $2 WHERE id = $1`, [jobId, targets.length + maxLlmBatches * llmBatchSize]);

    const workers = 6;
    let cursor = 0;
    async function worker() {
      for (;;) {
        const i = cursor++;
        if (i >= targets.length) return;
        const r = targets[i];
        const extId = String(r.external_id);
        const parts = extId.split(":");
        const tmdbId = parts[2] || "";
        const meta = (r.meta as Record<string, unknown>) || {};
        const type = (meta.tmdbType as string) || (parts[1] === "tv" ? "tv" : "movie");
        const d = await tmdbGet(type, tmdbId);
        if (!d) {
          detail.tmdbNotFound = (detail.tmdbNotFound as number) + 1;
        } else {
          const year = d.release_date?.slice(0, 4) || d.first_air_date?.slice(0, 4);
          const yearNum = year ? Number(year) : null;
          const overview = (d.overview || "").trim();
          const genreNames = (d.genres || []).map((g) => g.name).filter(Boolean).slice(0, 6);
          const studios = [
            ...(d.production_companies || []).slice(0, 2).map((c) => c.name),
            ...(d.networks || []).slice(0, 1).map((c) => c.name),
          ].filter(Boolean).slice(0, 2);
          const collectionName = d.belongs_to_collection?.name || null;
          const collectionId = d.belongs_to_collection?.id || null;
          const poster = r.thumbnail || (d.poster_path ? IMG + d.poster_path : null);
          const backdrop = r.backdrop || (d.backdrop_path ? IMG + d.backdrop_path : null);
          const rating = Number(r.rating || 0) > 0 ? Number(r.rating) : Number(d.vote_average || 0);

          const newMeta = {
            ...meta,
            genres: meta.genres ?? genreNames,
            studios: meta.studios ?? studios,
            collectionName: meta.collectionName ?? collectionName,
            collectionId: meta.collectionId ?? collectionId,
            runtime: d.runtime ?? (meta.runtime as unknown),
            aiExtractedAt: new Date().toISOString(),
          };

          await q(
            `UPDATE content SET
               year = COALESCE($2, year),
               description = CASE WHEN (description IS NULL OR description = '') AND $3 <> '' THEN $3 ELSE description END,
               rating = $4,
               thumbnail = COALESCE(thumbnail, $5),
               backdrop = COALESCE(backdrop, $6),
               meta = $7::jsonb,
               search_text = $8,
               updated_at = now()
             WHERE id = $1`,
            [
              Number(r.id),
              yearNum,
              overview,
              rating,
              poster,
              backdrop,
              JSON.stringify(newMeta),
              buildSearchText([
                r.title, r.original_title, overview || r.description,
                ((r.tags as string[]) || []).join(" "),
                genreNames.join(" "), r.category, r.brand, r.content_type, "tmdb",
              ]),
            ]
          );
          detail.tmdbUpdated = (detail.tmdbUpdated as number) + 1;
        }
        processed++;
      }
    }
    await Promise.all(Array.from({ length: workers }, worker));

    // ---------- FAZA 2: clasificare LLM canale TV/radio fără genuri ----------
    const llmTargets = await q<Row>(
      `SELECT c.id, c.title FROM content c
       WHERE c.content_type IN ('live_tv','radio')
         AND NOT EXISTS (SELECT 1 FROM content_genres cg WHERE cg.content_id = c.id)
       ORDER BY c.popularity DESC NULLS LAST, c.id
       LIMIT $1`,
      [maxLlmBatches * llmBatchSize]
    );
    for (let b = 0; b < maxLlmBatches; b++) {
      const batch = llmTargets.slice(b * llmBatchSize, (b + 1) * llmBatchSize);
      if (batch.length === 0) break;
      const map = await llmClassify(batch.map((r) => String(r.title)));
      detail.llmBatches = (detail.llmBatches as number) + 1;
      for (const [idx, genres] of map) {
        const row = batch[idx];
        if (!row) continue;
        const contentId = Number(row.id);
        for (const g of genres) {
          const slug = slugify(g);
          const gRow = await qOne<{ id: number }>(
            `INSERT INTO genres (slug, name, kind, source) VALUES ($1,$2,'genre','llm')
             ON CONFLICT (slug) DO UPDATE SET updated_at = now() RETURNING id`,
            [slug, g]
          );
          if (!gRow) continue;
          const res = await q<Row>(
            `INSERT INTO content_genres (content_id, genre_id, score, source) VALUES ($1,$2,0.8,'llm')
             ON CONFLICT (content_id, genre_id) DO NOTHING RETURNING 1`,
            [contentId, gRow.id]
          );
          inserted += res.length;
          detail.linksAdded = (detail.linksAdded as number) + res.length;
        }
        await q(
          `UPDATE content SET
             meta = jsonb_set(
               jsonb_set(COALESCE(meta,'{}'::jsonb), '{aiGenres}', $2::jsonb, true),
               '{aiExtractedAt}', to_jsonb(now()::text), true)
           WHERE id = $1`,
          [contentId, JSON.stringify(genres)]
        );
        detail.llmItems = (detail.llmItems as number) + 1;
      }
      processed += batch.length;
      await q(`UPDATE ai_jobs SET processed=$2 WHERE id=$1`, [jobId, processed]);
    }

    // ---------- FAZA 3: descrieri derivate REALE (TV/radio fără descriere) ----------
    const r1 = await q<Row>(
      `UPDATE content SET description =
         concat_ws(' • ', 'Canal TV live', NULLIF(category,''),
           CASE WHEN meta ? 'quality' THEN concat_ws(' ', 'calitate', meta->>'quality') END,
           CASE WHEN country IS NOT NULL THEN concat_ws(' ', 'țară:', upper(country)) END)
       WHERE content_type='live_tv' AND (description IS NULL OR description='')
       RETURNING id`,
      []
    );
    const r2 = await q<Row>(
      `UPDATE content SET description =
         concat_ws(' • ', 'Post radio live',
           CASE WHEN meta ? 'codec' THEN concat_ws(' ', 'codec', meta->>'codec') END,
           CASE WHEN meta ? 'bitrate' THEN concat_ws(' ', meta->>'bitrate', 'kbps') END,
           CASE WHEN country IS NOT NULL THEN concat_ws(' ', 'țară:', upper(country)) END,
           CASE WHEN array_length(tags,1) > 0 THEN array_to_string(tags[1:3], ', ') END)
       WHERE content_type='radio' AND (description IS NULL OR description='')
       RETURNING id`,
      []
    );
    detail.descDerived = (r1.length || 0) + (r2.length || 0);

    // invalidare cache căutare (metadatele s-au schimbat)
    await q(`DELETE FROM search_cache WHERE key LIKE 'sl:%' OR key LIKE 'sug:%'`).catch(() => {});

    const payload = detail;
    await finishJob(jobId, processed, inserted, payload);
    return { ok: true, processed, inserted, ...payload };
  } catch (e) {
    await finishJob(jobId, processed, inserted, detail, String(e));
    throw e;
  }
}
