// ============================================================
// Faza 12 — VALIDARE EMPIRICĂ LA SCARĂ a motorului de căutare pe x64
// Metodă onestă (documentată în /api/status):
//  1. baseline: latențe căutare pe bibliotecă GOALĂ (queries random, anti-cache)
//  2. inserează ~300K rânduri temp subțiri (provider='_scale_test', ușor de purge)
//     cu titluri combinatoriale realiste → densitate ~4.7K rânduri/partiție
//  3. măsoară aceleași queries la densitate (FTS+trigram+LIKE, ORDER BY score)
//  4. purjare completă + VACUUM → biblioteca rămâne la 0 (user-driven)
// Siguranță: monitorizare pg_database_size la fiecare 50 batch-uri,
// hard-stop la 420MB (Neon free tier 512MB), purge garantat în finally.
// Rulează: bun scripts/scale-validate.ts
// ============================================================
import { Pool, neonConfig } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;


const DB_URL = process.env.NEON_DATABASE_URL || "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 15_000, statement_timeout: 120_000 });

const TARGET_ROWS = 300_000;
const BATCH = 2_000;
const MAX_DB_MB = 420;
const SIZE_LIMIT_BYTES = MAX_DB_MB * 1024 * 1024;

// --- generare titluri combinatoriale realiste (RO, fără diacritice) ---
const W1 = ["umbra", "codul", "visul", "noaptea", "cetatea", "nomadul", "vulpea", "coroana", "ultima", "primul", "secretul", "razboiul", "pasiunea", "clipa", "ecoul", "steaua", "insula", "padurea", "regina", "mercenarul", "orizontul", "legenda", "calendarul", "farmacia", "tropicul", "berarul", "diplomatul", "ghicitorul", "hanul", "jumatatea", "lacul", "muntele", "navarul", "ocaul", "pescarul", "quasarul", "rafineria", "satelitul", "termometrul", "urologul"];
const W2 = ["nordului", "verde", "de fier", "pierduta", "albastra", "ascunsa", "eterna", "de stanca", "pnema", "din iarna", "lui vlad", "de sarare", "cu miere", "de marmura", "cu soare", "si umbra", "de溴 foc", "cureaua", "suspinul", "trofeul", "adevarului", "bucoviei", "carpatin", "daciei", "extraterestra", "fanatica", "grabita", "hipnotica", "ideala", "jucanita", "kilometrica", "luminoasa", "magica", "necunoscuta", "obiectiva", "paralela", "quieta", "rasaritana", "sarmatica", "transilvana"];
const TYPES = ["movie", "series", "music"];

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// curăț W2 de un caracter corupt accidental (dublu-filtrare sigură)
for (let i = 0; i < W2.length; i++) W2[i] = W2[i].replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function makeTitle(i: number): string {
  const w1 = W1[i % W1.length];
  const w2 = W2[Math.floor(i / W1.length) % W2.length];
  const num = Math.floor(i / (W1.length * W2.length));
  return num === 0 ? `${w1} ${w2}` : `${w1} ${w2} ${num}`;
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params as never[])).rows as T[];
}

// SQL-ul de căutare IDENTIC cu searchLibrary (FTS+trigram+LIKE, ranking hibrid)
function searchSQL(prefix: string, term: string): [string, unknown[]] {
  const normed = norm(prefix);
  const tsq = normed.split(" ").filter(Boolean).slice(0, 8).map((t) => `${t.replace(/[^\w]/g, "")}:*`).join(" & ");
  return [
    `SELECT id, title, popularity,
       (ts_rank(search_tsv, to_tsquery('simple', $1)) * 8
        + similarity(search_text, $2) * 3
        + CASE WHEN search_text LIKE $3 THEN 3 ELSE 0 END
        + LEAST(popularity, 5000) / 5000.0 * 1.2) AS score
     FROM content
     WHERE (search_text % $2 OR search_text LIKE $4)
     ORDER BY score DESC, popularity DESC, id DESC
     LIMIT 24`,
    [tsq, normed, normed + "%", `%${prefix}%`],
  ];
}

async function measure(label: string, queries: string[]): Promise<{ p50: number; p95: number; avg: number; n: number }> {
  const times: number[] = [];
  for (const qr of queries) {
    const [sql, params] = searchSQL(qr, norm(qr));
    const t0 = Date.now();
    const rows = await q(sql, params);
    times.push(Date.now() - t0);
    if (rows.length === 0 && times.length <= 2) console.log(`  atenție: 0 rezultate pentru "${qr}"`);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`${label}: P50=${p50}ms • P95=${p95}ms • avg=${avg}ms (${times.length} queries)`);
  return { p50, p95, avg, n: times.length };
}

function randomQueries(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const w1 = W1[Math.floor(Math.random() * W1.length)];
    const mode = Math.random();
    if (mode < 0.4) out.push(w1);                       // 1 cuvânt (common)
    else if (mode < 0.8) out.push(`${w1} ${W2[Math.floor(Math.random() * W2.length)]}`); // 2 cuvinte
    else out.push(w1.slice(0, 3) + String(Math.floor(Math.random() * 9)));               // prefix scurt + zgomot
  }
  return out;
}

let inserted = 0;
let aborted = false;

async function main() {
  const result: Record<string, unknown> = { at: new Date().toISOString(), targetRows: TARGET_ROWS };

  // ---- 1. BASELINE pe bibliotecă goală ----
  console.log("\n[1/5] Baseline: căutare pe bibliotecă GOALĂ (queries random anti-cache)");
  const baseQ = randomQueries(10);
  await measure("warmup", baseQ.slice(0, 3));
  result.baseline = await measure("baseline", baseQ);

  // ---- 2. INSERT în batch-uri cu monitorizare storage ----
  console.log(`\n[2/5] Insert ${TARGET_ROWS.toLocaleString("ro-RO")} rânduri temp (batch ${BATCH})…`);
  const tIns = Date.now();
  let dbSize = 0;
  for (let off = 0; off < TARGET_ROWS && !aborted; off += BATCH) {
    const vals: unknown[] = [];
    const rows: string[] = [];
    for (let j = 0; j < BATCH; j++) {
      const i = off + j;
      const title = makeTitle(i);
      const st = norm(`${title} scale test movie series music`);
      const b = j * 9;
      vals.push(
        `scaletest:${i}`, title, title, "Conținut de validare la scară Faza 12.",
        TYPES[i % 3], "_scale_test", "url", null, st
      );
      rows.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
    }
    await q(
      `INSERT INTO content (external_id, title, original_title, description, content_type, provider, source_type, source_url, search_text)
       VALUES ${rows.join(",")}`,
      vals
    );
    inserted += BATCH;
    if ((off / BATCH) % 25 === 0) {
      const sz = await q<{ b: string }>(`SELECT pg_database_size(current_database())::text AS b`);
      dbSize = Number(sz[0].b);
      const rate = Math.round(inserted / ((Date.now() - tIns) / 1000));
      console.log(`  ${inserted.toLocaleString("ro-RO")} rânduri • ${rate} rows/s • DB ${(dbSize / 1048576).toFixed(0)}MB`);
      if (dbSize > SIZE_LIMIT_BYTES) {
        console.log(`  HARD-STOP: DB ${(dbSize / 1048576).toFixed(0)}MB > ${MAX_DB_MB}MB — măsurăm cu ce avem`);
        aborted = true;
      }
    }
  }
  const insSec = (Date.now() - tIns) / 1000;
  result.inserted = inserted;
  result.insertSeconds = Math.round(insSec);
  result.insertRate = Math.round(inserted / insSec);
  result.dbSizeAfterInsertMb = Math.round(dbSize / 1048576);
  console.log(`Insert complet: ${inserted.toLocaleString("ro-RO")} în ${insSec.toFixed(1)}s (${result.insertRate} rows/s)`);

  // ---- 3. MĂSURĂTORI la densitate ----
  await q(`ANALYZE content`);
  console.log(`\n[3/5] Măsurători la densitate: ${inserted.toLocaleString("ro-RO")} rânduri / 64 partiții = ~${Math.round(inserted / 64).toLocaleString("ro-RO")}/partiție`);
  const loadQ = randomQueries(15);
  await measure("warmup-load", loadQ.slice(0, 3));
  result.loaded = await measure("loaded", loadQ);

  // sugestii index-only (forma suggest ≥4 caractere)
  const sugT: number[] = [];
  for (let i = 0; i < 10; i++) {
    const pfx = W1[Math.floor(Math.random() * W1.length)].slice(0, 4);
    const t0 = Date.now();
    await q(`SELECT DISTINCT title FROM content WHERE search_text LIKE $1 || '%' ORDER BY title LIMIT 7`, [norm(pfx)]);
    sugT.push(Date.now() - t0);
  }
  sugT.sort((a, b) => a - b);
  const sugP50 = sugT[Math.floor(sugT.length / 2)];
  console.log(`suggest index-only: P50=${sugP50}ms`);
  result.suggest = { p50: sugP50, n: sugT.length };

  // count la scară (proc inherit sanity)
  const cnt = await q<{ n: string }>(`SELECT count(*)::text AS n FROM content`);
  result.totalRowsInContent = Number(cnt[0].n);
  console.log(`count(*) total content: ${cnt[0].n}`);

  // ---- 4. EXTRAPOLARE onestă (metodă documentată) ----
  // B-tree depth crește logaritmic: 4.7K/partiție → 6.25M/partiție (1334x)
  // = +~2 niveluri de index → factor de latență estimat 1.4-1.7x pe origin.
  const densityFactor = 1.55;
  result.extrapolation = {
    method: "B-tree/GIN: latența origin crește sub-liniar cu densitatea; +2 niveluri index la 1334x → factor ~1.55x",
    perPartitionNow: Math.round(inserted / 64),
    perPartitionCeiling: 6_250_000,
    estP50AtCeiling: Math.round((result.loaded as { p50: number }).p50 * densityFactor),
    ceilingTotalRows: 6_250_000 * 64,
    pctOf30B: Math.round(((6_250_000 * 64) / 30_000_000_000) * 10000) / 100,
  };
  console.log(`\n[4/5] Extrapolare: P50 la plafon 6.25M/partiție ≈ ${result.extrapolation.estP50AtCeiling}ms (factor ${densityFactor}x)`);
  console.log(`      Plafon total x64: ${(6_250_000 * 64 / 1e6).toFixed(0)}M rânduri = ${result.extrapolation.pctOf30B}% din 30 mld`);

  // ---- 5. PURJARE GARANTATĂ ----
  console.log(`\n[5/5] PURJARE: DELETE provider='_scale_test'…`);
  const tDel = Date.now();
  await q(`DELETE FROM content WHERE provider = '_scale_test'`);
  console.log(`Deleted în ${((Date.now() - tDel) / 1000).toFixed(1)}s`);
  await q(`VACUUM content`);
  await q(`ANALYZE content`);
  await q(`DELETE FROM search_cache`);
  const after = await q<{ n: string; sz: string }>(
    `SELECT (SELECT count(*)::text FROM content) AS n, pg_size_pretty(pg_database_size(current_database()))::text AS sz`);
  result.afterPurge = { contentRows: Number(after[0].n), dbSize: after[0].sz };
  console.log(`FINAL: content=${after[0].n} rânduri • DB ${after[0].sz} (bibliotecă curată, user-driven păstrat)`);

  const { writeFileSync } = await import("node:fs");
  writeFileSync("/home/z/my-project/scripts/scale-validate-result.json", JSON.stringify(result, null, 2));
  console.log("Rezultat salvat: scripts/scale-validate-result.json");

  await pool.end();
}

main().catch(async (e) => {
  console.error("FAIL:", e.message || e);
  // purge garantat chiar și la eșec
  try {
    await pool.query(`DELETE FROM content WHERE provider = '_scale_test'`);
    await pool.query(`VACUUM content`);
    const r = await pool.query(`SELECT count(*)::text AS n FROM content`);
    console.log(`PURJARE de urgență OK: content=${r.rows[0].n}`);
  } catch (e2) {
    console.error("PURJARE DE URGENȚĂ A EȘUAT:", (e2 as Error).message);
  }
  pool.end().finally(() => process.exit(1));
});
