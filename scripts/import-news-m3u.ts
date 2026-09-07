// ============================================================
// Import M3U "Popular News - CODECS.COM" → Neon (content, tip live_tv)
// Rulează: bun scripts/import-news-m3u.ts
// - Parsează data/popular-news.m3u (964 canale)
// - Extrage țara din tvg-id, logo, grup, calitate, [Geo-blocked], [Not 24/7]
// - Detectează HLS (.m3u8) / DASH (.mpd) / SRT (srt://)
// - Inserare batch idempotentă (dedup pe md5(url))
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import { readFileSync } from "fs";
import { createHash } from "crypto";

neonConfig.webSocketConstructor = WebSocket;
const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 6 });

// ---------- țară → [nume RO, continent] ----------
const COUNTRY: Record<string, [string, string]> = {
  au: ["Australia", "Oceania"], nz: ["Noua Zeelandă", "Oceania"], fj: ["Fiji", "Oceania"],
  es: ["Spania", "Europa"], pt: ["Portugalia", "Europa"], fr: ["Franța", "Europa"],
  it: ["Italia", "Europa"], gr: ["Grecia", "Europa"], ro: ["România", "Europa"],
  md: ["Moldova", "Europa"], bg: ["Bulgaria", "Europa"], hu: ["Ungaria", "Europa"],
  al: ["Albania", "Europa"], xk: ["Kosovo", "Europa"], mk: ["Macedonia de Nord", "Europa"],
  rs: ["Serbia", "Europa"], hr: ["Croația", "Europa"], ba: ["Bosnia și Herțegovina", "Europa"],
  si: ["Slovenia", "Europa"], sk: ["Slovacia", "Europa"], cz: ["Cehia", "Europa"],
  pl: ["Polonia", "Europa"], de: ["Germania", "Europa"], at: ["Austria", "Europa"],
  ch: ["Elveția", "Europa"], nl: ["Olanda", "Europa"], be: ["Belgia", "Europa"],
  uk: ["Regatul Unit", "Europa"], ie: ["Irlanda", "Europa"], is: ["Islanda", "Europa"],
  se: ["Suedia", "Europa"], fi: ["Finlanda", "Europa"], dk: ["Danemarca", "Europa"],
  no: ["Norvegia", "Europa"], lt: ["Lituania", "Europa"], lv: ["Letonia", "Europa"],
  ee: ["Estonia", "Europa"], mt: ["Malta", "Europa"], cy: ["Cipru", "Europa"],
  mc: ["Monaco", "Europa"], ua: ["Ucraina", "Europa"], by: ["Belarus", "Europa"],
  ru: ["Rusia", "Europa"], tr: ["Turcia", "Europa"], am: ["Armenia", "Europa"],
  ge: ["Georgia", "Asia"], az: ["Azerbaidjan", "Asia"],
  us: ["Statele Unite", "America de Nord"], ca: ["Canada", "America de Nord"],
  mx: ["Mexic", "America de Nord"], gt: ["Guatemala", "America de Nord"],
  hn: ["Honduras", "America de Nord"], sv: ["El Salvador", "America de Nord"],
  ni: ["Nicaragua", "America de Nord"], cr: ["Costa Rica", "America de Nord"],
  pa: ["Panama", "America de Nord"], bz: ["Belize", "America de Nord"],
  cu: ["Cuba", "America de Nord"], ht: ["Haiti", "America de Nord"],
  do: ["Republica Dominicană", "America de Nord"], pr: ["Puerto Rico", "America de Nord"],
  jm: ["Jamaica", "America de Nord"], bs: ["Bahamas", "America de Nord"],
  co: ["Colombia", "America de Sud"], ve: ["Venezuela", "America de Sud"],
  ec: ["Ecuador", "America de Sud"], pe: ["Peru", "America de Sud"],
  bo: ["Bolivia", "America de Sud"], br: ["Brazilia", "America de Sud"],
  py: ["Paraguay", "America de Sud"], cl: ["Chile", "America de Sud"],
  ar: ["Argentina", "America de Sud"], uy: ["Uruguay", "America de Sud"],
  cn: ["China", "Asia"], hk: ["Hong Kong", "Asia"], tw: ["Taiwan", "Asia"],
  mo: ["Macao", "Asia"], jp: ["Japonia", "Asia"], kr: ["Coreea de Sud", "Asia"],
  kp: ["Coreea de Nord", "Asia"], mn: ["Mongolia", "Asia"], th: ["Thailanda", "Asia"],
  vn: ["Vietnam", "Asia"], ph: ["Filipine", "Asia"], id: ["Indonezia", "Asia"],
  my: ["Malaysia", "Asia"], sg: ["Singapore", "Asia"], mm: ["Myanmar", "Asia"],
  bd: ["Bangladesh", "Asia"], in: ["India", "Asia"], pk: ["Pakistan", "Asia"],
  lk: ["Sri Lanka", "Asia"], np: ["Nepal", "Asia"], mv: ["Maldive", "Asia"],
  af: ["Afganistan", "Asia"], kz: ["Kazahstan", "Asia"], uz: ["Uzbekistan", "Asia"],
  kg: ["Kârgâzstan", "Asia"], tj: ["Tadjikistan", "Asia"], ir: ["Iran", "Asia"],
  iq: ["Irak", "Asia"], sa: ["Arabia Saudită", "Asia"], ae: ["Emiratele Arabe Unite", "Asia"],
  qa: ["Qatar", "Asia"], kw: ["Kuweit", "Asia"], om: ["Oman", "Asia"],
  bh: ["Bahrain", "Asia"], ye: ["Yemen", "Asia"], jo: ["Iordania", "Asia"],
  lb: ["Liban", "Asia"], sy: ["Siria", "Asia"], ps: ["Palestina", "Asia"],
  il: ["Israel", "Asia"], la: ["Laos", "Asia"], kh: ["Cambodgia", "Asia"],
  ma: ["Maroc", "Africa"], dz: ["Algeria", "Africa"], tn: ["Tunisia", "Africa"],
  ly: ["Libia", "Africa"], eg: ["Egipt", "Africa"], sd: ["Sudan", "Africa"],
  et: ["Etiopia", "Africa"], ke: ["Kenya", "Africa"], ug: ["Uganda", "Africa"],
  tz: ["Tanzania", "Africa"], ng: ["Nigeria", "Africa"], gh: ["Ghana", "Africa"],
  sn: ["Senegal", "Africa"], cm: ["Camerun", "Africa"], ci: ["Coasta de Fildeș", "Africa"],
  bf: ["Burkina Faso", "Africa"], ne: ["Niger", "Africa"], ml: ["Mali", "Africa"],
  gn: ["Guinea", "Africa"], bj: ["Benin", "Africa"], tg: ["Togo", "Africa"],
  cd: ["RD Congo", "Africa"], cg: ["Congo", "Africa"], za: ["Africa de Sud", "Africa"],
  na: ["Namibia", "Africa"], zw: ["Zimbabwe", "Africa"], zm: ["Zambia", "Africa"],
  ao: ["Angola", "Africa"], mz: ["Mozambic", "Africa"], mg: ["Madagascar", "Africa"],
  mu: ["Mauritius", "Africa"], rw: ["Rwanda", "Africa"], bi: ["Burundi", "Africa"],
};

const LANG: Record<string, string> = {
  ro: "ro", md: "ro", es: "es", fr: "fr", de: "de", it: "it", pt: "pt", br: "pt",
  ru: "ru", tr: "tr", in: "hi", cn: "zh", tw: "zh", hk: "zh", jp: "ja", kr: "ko",
  gr: "el", pl: "pl", hu: "hu", cz: "cs", se: "sv", fi: "fi", nl: "nl",
};

const FLAGSHIP = [
  "bbc", "cnn", "al jazeera", "france 24", "dw ", "euronews", "sky news", "fox news",
  "nbc news", "abc news", "cbs news", "reuters", "trt world", "cgtn", "nhk", "cna",
  "al arabiya", "ndtv", "wion", "times now", "newsmax", "bloomberg", "aaj tak",
  "india today", "digi 24", "tvr info", "pro tv", "observator", "aleph news", "e! ",
];

function normalizeRo(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// ---------- parser M3U ----------
type Entry = {
  title: string; url: string; tvgId: string; logo: string | null;
  group: string; country: string | null; quality: string | null;
  geoBlocked: boolean; not247: boolean;
};

function parseM3U(text: string): Entry[] {
  const lines = text.split(/\r?\n/);
  const out: Entry[] = [];
  let pending: Partial<Entry> | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const commaIdx = line.lastIndexOf('",');
      const title = commaIdx >= 0 ? line.slice(commaIdx + 2).trim() : line.split(",").pop()?.trim() || "";
      const tvgId = /tvg-id="([^"]*)"/.exec(line)?.[1] || "";
      const logo = /tvg-logo="([^"]*)"/.exec(line)?.[1] || null;
      const group = /group-title="([^"]*)"/.exec(line)?.[1] || "News";
      pending = { title, tvgId, logo, group } as Partial<Entry>;
    } else if (!line.startsWith("#") && pending) {
      const u = line;
      const cc = /@/.test(pending.tvgId || "")
        ? (pending.tvgId!.split("@")[0].split(".").pop() || "").toLowerCase()
        : null;
      const country = cc && COUNTRY[cc] ? cc : cc ? cc : null;
      out.push({
        title: pending.title || "Canal fără nume",
        url: u,
        tvgId: pending.tvgId || "",
        logo: pending.logo || null,
        group: pending.group || "News",
        country,
        quality: /\((\d{3,4}[pi])\)/.exec(pending.title || "")?.[1] || null,
        geoBlocked: /\[Geo-blocked\]/i.test(pending.title || ""),
        not247: /\[Not 24\/7\]/i.test(pending.title || ""),
      });
      pending = null;
    }
  }
  return out;
}

// ---------- main ----------
const m3u = readFileSync("/home/z/my-project/data/popular-news.m3u", "utf8");
const entries = parseM3U(m3u);
console.log(`Parse: ${entries.length} canale`);

type Row = unknown[];
const rows: Row[] = [];
for (const e of entries) {
  const cinfo = e.country ? COUNTRY[e.country] || null : null;
  const countryName = cinfo ? cinfo[0] : null;
  const continent = cinfo ? cinfo[1] : "Global";
  let stype = "hls";
  let provider = "hls";
  if (e.url.startsWith("srt://")) { stype = "srt"; provider = "srt"; }
  else if (/\.mpd(\?|$)/.test(e.url)) { stype = "dash"; provider = "dash"; }
  else if (/\.m3u8(\?|$)/.test(e.url)) { stype = "hls"; provider = "hls"; }
  else if (/\.mp4(\?|$)/.test(e.url)) { stype = "video"; provider = "mp4"; }
  else { stype = "hls"; provider = "hls"; } // IPTV: URL gol → de obicei HLS

  const groups = e.group.split(";").map((g) => g.trim()).filter(Boolean);
  const norm = normalizeRo(e.title);
  const flagship = FLAGSHIP.some((f) => norm.includes(normalizeRo(f)));
  const popularity = flagship ? 500 : e.country === "ro" ? 400 : 25;
  const lang = (e.country && LANG[e.country]) || "en";
  const descBits = ["Canal TV live de știri"];
  if (countryName) descBits.push(`din ${countryName}`);
  if (e.quality) descBits.push(`calitate ${e.quality}`);
  if (e.geoBlocked) descBits.push("geo-blocat în unele regiuni");
  if (e.not247) descBits.push("nu emite 24/7");
  const description = descBits.join(", ") + ".";
  const search_text = normalizeRo(
    [e.title, groups.join(" "), countryName || "", "live tv stiri televiziune news"].join(" ")
  );
  const externalId = `popnews:${md5(e.url)}`;

  rows.push([
    externalId, e.title, description, "live_tv", "Popular News",
    groups[0] || "News", continent, e.country, lang, provider, stype, e.url,
    e.logo, e.quality, e.geoBlocked, e.not247, popularity,
    [...groups, e.country || "", "live", e.quality || ""].filter(Boolean),
    search_text,
    JSON.stringify({ tvgId: e.tvgId, quality: e.quality, geoBlocked: e.geoBlocked, not247: e.not247, playlist: "Popular News - CODECS.COM", streamGuess: stype === "hls" && !/\.m3u8/.test(e.url) }),
  ]);
}

// dedup: încarcă external_id existente pentru playlist
const existing = new Set<string>();
{
  const res = await pool.query(
    `SELECT external_id FROM content WHERE external_id LIKE 'popnews:%' LIMIT 200000`
  );
  for (const r of res.rows) existing.add(String(r.external_id));
}
const toInsert = rows.filter((r) => !existing.has(String(r[0])));
console.log(`Există deja: ${existing.size}; de inserat: ${toInsert.length}`);

const COLS = `external_id,title,description,content_type,brand,category,continent,country,language,
provider,source_type,source_url,thumbnail,meta_quality,meta_geo,meta_not247,popularity,tags,
search_text,meta`;

// adaugă coloanele ajutătoare dacă lipsesc (idempotent)
await pool.query(`ALTER TABLE content ADD COLUMN IF NOT EXISTS meta_quality TEXT`);
await pool.query(`ALTER TABLE content ADD COLUMN IF NOT EXISTS meta_geo BOOLEAN DEFAULT false`);
await pool.query(`ALTER TABLE content ADD COLUMN IF NOT EXISTS meta_not247 BOOLEAN DEFAULT false`);

let inserted = 0;
const BATCH = 50;
for (let i = 0; i < toInsert.length; i += BATCH) {
  const chunk = toInsert.slice(i, i + BATCH);
  const values: unknown[] = [];
  const tuples = chunk.map((r, ri) => {
    const ph = r.map((_, ci) => `$${ri * 20 + ci + 1}`);
    r.forEach((v) => values.push(v));
    return `(${ph.join(",")})`;
  });
  await pool.query(
    `INSERT INTO content (${COLS.replace(/\s+/g, " ")}) VALUES ${tuples.join(",")}`,
    values as never[]
  );
  inserted += chunk.length;
  if ((i / BATCH) % 4 === 0) console.log(`... ${inserted} inserate`);
}

const total = await pool.query(`SELECT count(*)::int AS n FROM content`);
const tv = await pool.query(`SELECT count(*)::int AS n FROM content WHERE content_type='live_tv'`);
const countries = await pool.query(`SELECT count(DISTINCT country)::int AS n FROM content WHERE content_type='live_tv'`);
console.log(`GATA: +${inserted} canale TV live; total content=${total.rows[0].n}; live_tv=${tv.rows[0].n}; țări=${countries.rows[0].n}`);
await pool.end();
