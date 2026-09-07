// ============================================================
// Ingest Faza 6 — RADIO LIVE GLOBAL (radio-browser.info)
// Sursă: dataset descărcat anterior în data/radio/p0..p15.json
// (top 8.000 posturi după clickcount, hidebroken=true, https).
// Filtru: doar streamuri direct reproductibile în playerul universal:
//   MP3/AAC/OGG/FLAC direct + HLS (.m3u8). Excludem playlisturi
//   .pls/.asx/.ram și codecuri UNKNOWN non-HLS.
// Scriere 100% în Neon (zero local): content_type='radio',
// provider='radio-browser', popularity=clickcount.
// Idempotent: external_id = radio:md5(url_resolved) + dedup vs. DB.
// Rulează: bun scripts/ingest-radio-v6.ts
// ============================================================
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

import { COUNTRY_INFO } from "../src/lib/countries";
import { normalizeRo } from "../src/lib/neon-search";

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL!
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 8 });

// continent fallback pentru coduri ISO lipsă din COUNTRY_INFO (radio acoperă mai multe țări decât playlistul TV)
const CONTINENT_EXTRA: Record<string, string> = {
  ad: "Europa", li: "Europa", sm: "Europa", va: "Europa", gi: "Europa", im: "Europa",
  gg: "Europa", je: "Europa", fo: "Europa", gl: "America de Nord", ax: "Europa",
  aw: "America de Nord", ai: "America de Nord", ag: "America de Nord", dm: "America de Nord",
  gd: "America de Nord", kn: "America de Nord", lc: "America de Nord", vc: "America de Nord",
  bb: "America de Nord", tc: "America de Nord", ky: "America de Nord", vg: "America de Nord",
  vi: "America de Nord", mf: "America de Nord", sx: "America de Nord", bq: "America de Nord",
  gp: "America de Nord", mq: "America de Nord", sr: "America de Sud", gy: "America de Sud",
  gf: "America de Sud", bo2: "America de Sud", ec2: "America de Sud",
  km: "Africa", dj: "Africa", so: "Africa", er: "Africa", ss: "Africa", td: "Africa",
  cf: "Africa", gq: "Africa", ga: "Africa", st: "Africa", gw: "Africa", gm: "Africa",
  cv: "Africa", sl: "Africa", lr: "Africa", sz: "Africa", ls: "Africa", bw: "Africa",
  mw: "Africa", sc: "Africa", km2: "Africa", yt: "Africa", re: "Africa", sh: "Africa",
  eh: "Africa", uz2: "Asia", tm: "Asia", bt: "Asia", bn: "Asia", tl: "Asia", tp: "Asia",
  pg: "Oceania", sb: "Oceania", vu: "Oceania", nc: "Oceania", pf: "Oceania",
  ws: "Oceania", to: "Oceania", ki: "Oceania", fm: "Oceania", mh: "Oceania",
  pw: "Oceania", nr: "Oceania", tv: "Oceania", ck: "Oceania", nu: "Oceania",
  as: "Oceania", gu: "Oceania", mp: "Oceania", wf: "Oceania", tk: "Oceania",
};

function continentOf(code: string): string {
  if (!code) return "Global";
  return COUNTRY_INFO[code]?.[1] || CONTINENT_EXTRA[code] || "Global";
}

type Station = {
  name: string;
  url_resolved: string;
  favicon: string;
  countrycode: string;
  tags: string;
  codec: string;
  bitrate: number;
  clickcount: number;
  votes: number;
  languagecodes: string;
  homepage: string;
};

const OK_SRC = /\.(mp3|aac|ogg|oga|m4a|flac)(\?|$)/i;
const HLS_SRC = /\.m3u8(\?|$)/i;
const BAD_SRC = /\.(pls|asx|ram|m3u|html?|php)$/i;

function usable(st: Station): boolean {
  if (!st?.name?.trim() || !st?.url_resolved) return false;
  const u = st.url_resolved.toLowerCase();
  if (BAD_SRC.test(u)) return false;
  if (HLS_SRC.test(u)) return true; // HLS e redabil prin hls.js
  const codec = String(st.codec || "").toUpperCase();
  return ["MP3", "AAC", "AAC+", "AACP", "OGG", "FLAC", "MP3,H.264"].includes(codec) || OK_SRC.test(u);
}

/** Citește dataset-ul descărcat local (data/radio/p*.json). */
function loadStations(): Station[] {
  const dir = path.join(import.meta.dir, "..", "data", "radio");
  const files = readdirSync(dir).filter((f) => /^p\d+\.json$/.test(f)).sort(
    (a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])
  );
  const out: Station[] = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Station[];
    out.push(...data);
  }
  return out;
}

async function main() {
  console.log("=== Ingest RADIO LIVE (radio-browser) — Faza 6 ===");
  const t0 = Date.now();

  const all = loadStations();
  console.log(`Încărcate local: ${all.length} posturi (data/radio/p*.json)`);
  const good = all.filter(usable);
  console.log(`Reproductibile: ${good.length}/${all.length} (filtru codec/URL)`);

  // --- dedup: pe md5(url) + pe nume normalizat+țară (păstrăm clickcount maxim) ---
  const md5Of = (st: Station) => createHash("md5").update(st.url_resolved).digest("hex");
  const seenName = new Map<string, Station>();
  const seenUrl = new Set<string>();
  for (const st of good) {
    if (seenUrl.has(md5Of(st))) continue;
    seenUrl.add(md5Of(st));
    const nameKey = `${normalizeRo(st.name).slice(0, 80)}|${(st.countrycode || "").toLowerCase()}`;
    const prev = seenName.get(nameKey);
    if (!prev || (st.clickcount || 0) > (prev.clickcount || 0)) seenName.set(nameKey, st);
  }
  const finalList = [...seenName.values()];
  console.log(`După dedup: ${finalList.length} posturi unice`);

  // --- dedup vs. biblioteca existentă (external_id deja inserate) ---
  const extIdOf = (st: Station) => `radio:${md5Of(st)}`;
  const allExtIds = finalList.map(extIdOf);
  const existingSet = new Set<string>();
  for (let i = 0; i < allExtIds.length; i += 500) {
    const chunk = allExtIds.slice(i, i + 500);
    const ph = chunk.map((_, j) => `$${j + 1}`).join(",");
    const rows = await pool.query(
      `SELECT external_id FROM content WHERE external_id IN (${ph})`,
      chunk
    );
    for (const r of rows.rows) existingSet.add(String(r.external_id));
  }
  console.log(`Deja în bibliotecă: ${existingSet.size} (se sare)`);

  const toInsert = finalList.filter((st) => !existingSet.has(extIdOf(st)));
  console.log(`De inserat: ${toInsert.length} posturi noi`);

  // --- inserare în batch-uri de 100 ---
  let inserted = 0;
  const CH = 100;
  for (let i = 0; i < toInsert.length; i += CH) {
    const chunk = toInsert.slice(i, i + CH);
    const values: unknown[] = [];
    const tuples: string[] = [];
    let p = 0;
    for (const st of chunk) {
      const cc = (st.countrycode || "").toLowerCase();
      const continent = continentOf(cc);
      const tags = (st.tags || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 1 && t.length < 30)
        .slice(0, 6);
      const lang = (st.languagecodes || "").split(",")[0]?.trim().slice(0, 8) || null;
      const isHls = HLS_SRC.test(st.url_resolved.toLowerCase());
      const title = st.name.trim().slice(0, 180);
      const desc = `Radio live ${st.name.trim().slice(0, 100)}${cc ? ` • ${COUNTRY_INFO[cc]?.[0] || cc.toUpperCase()}` : ""}${tags.length ? ` • ${tags.slice(0, 3).join(", ")}` : ""}${st.bitrate ? ` • ${st.bitrate}kbps ${st.codec}` : ""}`;
      const search_text = normalizeRo(
        [title, tags.join(" "), cc, continent, "radio", lang || "", st.codec || ""].join(" ")
      );
      const meta = {
        bitrate: st.bitrate || null,
        codec: st.codec || null,
        homepage: st.homepage || null,
        votes: st.votes || 0,
      };
      const pop = Math.min(Math.max(st.clickcount || 0, 1), 100_000);

      const rowVals = [
        extIdOf(st), title, null, desc, "radio", null,
        tags[0] || "radio", continent, cc || null, lang || "en",
        "radio-browser", isHls ? "hls" : "audio", st.url_resolved, null,
        (st.favicon || "").startsWith("https://") ? st.favicon : null,
        null, tags, search_text, JSON.stringify(meta), null, pop,
      ];
      for (const v of rowVals) {
        values.push(v);
        p++;
      }
      tuples.push(`(${Array.from({ length: 21 }, (_, k) => `$${p - 21 + k + 1}`).join(",")})`);
    }
    const sql = `INSERT INTO content
      (external_id, title, original_title, description, content_type, brand, category,
       continent, country, language, provider, source_type, source_url, embed_code,
       thumbnail, year, tags, search_text, meta, created_by, popularity)
      VALUES ${tuples.join(",")}`;
    await pool.query(sql, values);
    inserted += chunk.length;
    if ((i / CH) % 10 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${inserted}/${toInsert.length} inserate • ${((Date.now() - t0) / 1000).toFixed(0)}s • ${(inserted / el).toFixed(0)} rows/s`);
    }
  }

  console.log(`\nInserare completă: ${inserted} posturi radio în ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // --- count final + refresh rollup + vacuum ---
  const cnt = await pool.query(
    `SELECT count(*)::int AS radio FROM content WHERE content_type = 'radio'`
  );
  const total = await pool.query(`SELECT count(*)::int AS n FROM content`);
  console.log(`Radio în bibliotecă: ${cnt.rows[0].radio} • Total conținuturi: ${total.rows[0].n}`);

  for (const len of [1, 2, 3]) {
    const r = await pool.query(`SELECT refresh_suggest_rollup($1) AS n`, [len]);
    console.log(`rollup len=${len}: ${r.rows[0].n} bucket-e`);
  }

  await pool.query(`VACUUM ANALYZE content`);
  await pool.query(`VACUUM ANALYZE suggest_rollup`);
  console.log("VACUUM ANALYZE OK (visibility map pentru index-only scans)");
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
