// ============================================================
// FAZA 16b — INGEST LA SCARĂ: 1M+ rânduri distribuite pe shard-uri ACTIVE
// ============================================================
// Demonstrație REALĂ (zero simulare) a pipeline-ului de sharding:
//  • rutare BATCH cu ACEEAȘI funcție hash FNV-1a ca pickShardFor (producție)
//  • INSERT multi-VALUES direct pe compute-ul deținător (primar + shard remote)
//  • content_shard_map scris batch (ca la rutarea reală) pentru lookup cross-compute
//  • valuri adaptate la plafonul de STOCARE al planului Neon (~0,5 GB sandbox):
//    fiecare val = insert → măsurătoare → căutare la densitate live → PURJARE
//    + VACUUM (spațiul e reutilizat de valul următor) → până la 1M+ procesate
//  • validare căutare SCATTER-GATHER pe shard-uri active la vârf
//  • audit în ingest_scale_log (Neon) + JSON rezultat
// Phases: run (ingest complet) | cleanup (purjare totală + restaurare stare)
// Idempotent / re-entrant: starea per val în scripts/ingest-scale-state-v16.json
// ============================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

import { getActiveShards, getShards, shardQuery, invalidateShardRegistry, routeBatch, type Shard } from "../src/lib/shards";
import { q, qOne } from "../src/lib/pg";
import { searchLibrary } from "../src/lib/neon-search";

const TOTAL_TARGET = Number(process.argv[2] || "") || 1_050_000;
const PHASE = process.argv[3] || "run";

const URL =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const PREFIX = "scale16";
const PROVIDER = "_scale16";
// ⚠️ LIMITE VERIFYATE EMPIRIC: Neon plafonează la 512 MB PER PROIECT (cod 53100).
// Fișierele NU se micșorează la DELETE — doar VACUUM marchează spațiul reutilizabil
// (de aceea fiecare purjare face VACUUM ANALYZE). Bugetul e pe DATE LIVE:
// fiecare val pornește cu 0 rânduri live, deci valul poate folosi întreg bugetul.
const SAFE_DATA = 200 * 1024 * 1024;       // buget date live scale16 (proiect)
const HARD_FILE_LIMIT = 480 * 1024 * 1024; // gardă hard: oprește valul înainte de 53100
const COMPACT_THRESHOLD = 330 * 1024 * 1024; // peste asta → VACUUM FULL după val
const MARGINAL_FLOOR = 2048;               // bytes/rând minim în estimare (GIN crește costul)
const CHUNK = 1000;                         // rânduri per statement
const STREAMS_PER_SHARD = 2;                // stream-uri paralele per shard (masca latența WS)
const STATE_FILE = "/home/z/my-project/scripts/ingest-scale-state-v16.json";
const RESULT_FILE = "/home/z/my-project/scripts/ingest-scale-result-v16.json";

const admin = new Pool({ connectionString: URL, max: 3 });

type State = {
  waves: { wave: number; inserted: number; perShard: Record<string, number>; ranges: Record<string, { min: number; max: number }>; ms: number }[];
  totalProcessed: number;
};

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  return { waves: [], totalProcessed: 0 };
}
function saveState(s: State) {
  writeFileSync(STATE_FILE, JSON.stringify(s));
}

async function dbSize(pool: Pool): Promise<number> {
  const r = await pool.query(`SELECT pg_database_size(current_database())::bigint AS sz`);
  return Number((r.rows[0] as { sz: string }).sz);
}

/** pool per shard remote (local = admin) */
const remotePools = new Map<number, Pool>();
function poolFor(shard: Shard): Pool {
  if (shard.kind === "local") return admin;
  let p = remotePools.get(shard.id);
  if (!p) {
    p = new Pool({ connectionString: shard.dsn as string, max: 6, idleTimeoutMillis: 15_000, connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 90_000 } as never);
    remotePools.set(shard.id, p);
  }
  return p;
}

function normalizeLocal(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** generează rânduri slim (module combinatoriale RO) pentru un interval */
function genRows(wave: number, from: number, count: number): { extIds: string[]; titles: string[] } {
  const words = ["streaming", "aventura", "comedie", "drama", "actiune", "documentar", "familie", "mister", "panorama", "orizont", "legenda", "calatorie"];
  const extIds: string[] = [];
  const titles: string[] = [];
  for (let i = from; i < from + count; i++) {
    const w1 = words[i % words.length];
    const w2 = words[(i * 7 + wave) % words.length];
    extIds.push(`${PREFIX}:w${wave}:${i}`);
    titles.push(`${w1[0].toUpperCase() + w1.slice(1)} ${w2} val ${wave} #${i} film online`);
  }
  return { extIds, titles };
}

/** INSERT batch pe un shard: întoarce (external_id, id) pentru hartă */
async function insertChunk(shard: Shard, rows: { extId: string; title: string }[]): Promise<{ extId: string; id: number }[]> {
  const values: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  for (const r of rows) {
    const st = normalizeLocal(r.title);
    const ph = Array.from({ length: 9 }, () => { p++; return `$${p}`; });
    values.push(`(${ph.join(",")})`);
    params.push(r.extId, r.title, "", "video", PROVIDER, "url", st, "{}", "{}");
  }
  const sql = `INSERT INTO content
      (external_id, title, description, content_type, provider, source_type, search_text, meta, tags)
    VALUES ${values.join(",")}
    ON CONFLICT DO NOTHING
    RETURNING id, external_id`;
  const res = (await poolFor(shard).query(sql, params as never[])) as { rows: { id: string; external_id: string }[] };
  return res.rows.map((r) => ({ extId: r.external_id, id: Number(r.id) }));
}

/** hartă de rutare batch (ca producția) */
async function upsertMapBatch(entries: { extId: string; id: number }[], shardId: number): Promise<void> {
  if (entries.length === 0) return;
  for (let i = 0; i < entries.length; i += 1000) {
    const chunk = entries.slice(i, i + 1000);
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    for (const e of chunk) {
      values.push(`($${++p},$${++p},$${++p})`);
      params.push(e.extId, shardId, e.id);
    }
    await q(
      `INSERT INTO content_shard_map (external_id, shard_id, remote_id)
       VALUES ${values.join(",")}
       ON CONFLICT (external_id) DO UPDATE SET shard_id = EXCLUDED.shard_id, remote_id = EXCLUDED.remote_id`,
      params
    );
  }
}

async function purgeWave(shard: Shard, range: { min: number; max: number }): Promise<void> {
  await poolFor(shard).query(`DELETE FROM content WHERE provider = $1 AND id BETWEEN $2 AND $3`, [PROVIDER, range.min, range.max]);
  await poolFor(shard).query(`VACUUM ANALYZE content`);
}

/** Compactare FIZICĂ (VACUUM FULL per partiție) — fișierele revin la dimensiunea datelor live. */
async function compactShard(shard: Shard): Promise<void> {
  const parts = await poolFor(shard).query(
    `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'content'::regclass ORDER BY c.relname`
  );
  for (const r of parts.rows as { relname: string }[]) {
    await poolFor(shard).query(`VACUUM FULL ANALYZE "${r.relname}"`);
  }
  try { await poolFor(shard).query(`VACUUM FULL ANALYZE content_shard_map`); } catch { /* doar primar */ }
}

/** Compactă ambele shard-uri în paralel (când fișierele au crescut prea mult). */
async function compactAll(shards: Shard[]): Promise<void> {
  const t = Date.now();
  await Promise.all(shards.map((s) => compactShard(s)));
  console.log(`[compactare] VACUUM FULL complet în ${((Date.now() - t) / 1000).toFixed(0)}s`);
}

// ============================================================
async function run() {
  const t0 = Date.now();
  const state = loadState();

  // 0) activăm shard-urile disponibile (shard_b rămăsese disabled după Faza 15)
  const all = await getShards(true);
  const remoteReg = all.find((s) => s.kind === "remote");
  let remoteRestoredState: string | null = null;
  if (remoteReg && remoteReg.state !== "active") {
    remoteRestoredState = remoteReg.state;
    await admin.query(`UPDATE shards SET state = 'active' WHERE id = $1`, [remoteReg.id]);
    invalidateShardRegistry();
  }
  const active = await getActiveShards();
  console.log(`Shard-uri ACTIVE: ${active.map((s) => `${s.name}[${s.kind}]`).join(", ")}`);
  if (active.length < 2) {
    console.log("⚠️ Un singur shard activ — demonstrația rulează pe primar (shard_b indisponibil)");
  }

  // reluare: purjăm eventualele resturi dintr-o val întreruptă (state-ul numără
  // doar valurile COMPLETE — resturile nu intră în totalProcessed) + VACUUM
  // OBLIGATORIU (spațiul mort devine reutilizabil, altfel 53100 la insert)
  for (const shard of active) {
    const r = (await poolFor(shard).query(`DELETE FROM content WHERE provider = $1`, [PROVIDER])) as { rowCount: number | null };
    if (r.rowCount) console.log(`[reluare] ${shard.name}: ${r.rowCount} rânduri de la o val întreruptă au fost purjate`);
    await poolFor(shard).query(`VACUUM ANALYZE content`);
  }
  await q(`DELETE FROM content_shard_map WHERE external_id LIKE '${PREFIX}:%'`);
  await q(`VACUUM ANALYZE content_shard_map`).catch(() => {});

  // fișiere umflate de la o val întreruptă? compactăm ÎNAINTE de valuri
  const usedStart = (await Promise.all(active.map((s) => dbSize(poolFor(s))))).reduce((a, b) => a + b, 0);
  if (usedStart > COMPACT_THRESHOLD) {
    console.log(`[compactare] fișiere=${(usedStart / 1024 / 1024).toFixed(0)}MB > ${(COMPACT_THRESHOLD / 1024 / 1024).toFixed(0)}MB — VACUUM FULL la pornire...`);
    await compactAll(active);
  }

  const shardsUsed = active.length;
  let totalProcessed = state.totalProcessed;
  let wave = state.waves.length + 1;

  // 1) CALIBRARE — o probă mică pentru bytes/rând (o purjăm imediat).
  //    Costul = CREȘTEREA fișierelor (nu dimensiunea totală — fișierele pot
  //    fi deja mari de la valurile anterioare).
  console.log("\n[calibrare] 5.000 rânduri probă...");
  const calBefore = (await Promise.all(active.map((s) => dbSize(poolFor(s))))).reduce((a, b) => a + b, 0);
  const calRows = genRows(0, 9_900_000, 5_000);
  const calByShard = new Map<number, { extId: string; title: string }[]>();
  {
    // rutare batch pe shard-uri active (același hash ca producția)
    const routed = routeBatch(calRows.extIds, active);
    const titleOf = new Map(calRows.extIds.map((e, i) => [e, calRows.titles[i]]));
    for (const [shardId, ids] of routed) {
      const shard = active.find((s) => s.id === shardId)!;
      calByShard.set(shardId, ids.map((id) => ({ extId: id, title: titleOf.get(id)! })));
    }
    for (const [shardId, rows] of calByShard) {
      const shard = active.find((s) => s.id === shardId)!;
      await insertChunk(shard, rows);
    }
  }
  let calSizes: number[] = [];
  for (const shard of active) calSizes.push(await dbSize(poolFor(shard)));
  const calAfter = calSizes.reduce((a, b) => a + b, 0);
  const calPerRow = Math.max(MARGINAL_FLOOR, (calAfter - calBefore) / 5_000);
  console.log(`[calibrare] ${(calPerRow / 1024).toFixed(2)} KB/rând marginal (fișiere: ${(calAfter / 1024 / 1024).toFixed(0)}MB total)`);
  // purjăm proba
  for (const shard of active) {
    await poolFor(shard).query(`DELETE FROM content WHERE provider = $1`, [PROVIDER]);
    await poolFor(shard).query(`VACUUM ANALYZE content`);
  }
  await q(`DELETE FROM content_shard_map WHERE external_id LIKE '${PREFIX}:%'`);

  // 2) VALURI până la țintă — buget pe DATE LIVE (fiecare val pornește de la
  //    0 live, fișierele existente sunt reutilizate prin VACUUM post-purjare)
  let marginalPerRow = Math.max(calPerRow, MARGINAL_FLOOR);
  let lastSearch: { p50: number; p95: number; hits: number } | null = null;
  while (totalProcessed < TOTAL_TARGET) {
    const wStart = Date.now();
    const sizesBefore = await Promise.all(active.map((s) => dbSize(poolFor(s))));
    const waveRows = Math.min(TOTAL_TARGET - totalProcessed, Math.floor(SAFE_DATA / marginalPerRow));
    process.stdout.write(`\n[val ${wave}] ${waveRows.toLocaleString("ro-RO")} rânduri → ${active.length} shard-uri... `);

    // rutare batch (hash FNV-1a — identic cu pickShardFor din producție)
    const perShardCounts: Record<string, number> = {};
    const ranges: Record<string, { min: number; max: number }> = {};
    const insertedPerShard: Record<string, number> = {};

    const BATCHES = 10; // sub-loturi pentru progres + guard stocare
    const subSize = Math.ceil(waveRows / BATCHES);
    let insertedWave = 0;
    let storageAbort = false;
    const collectedMap: { extId: string; id: number; shardId: number }[] = [];
    for (let b = 0; b < BATCHES && !storageAbort; b++) {
      const gen = genRows(wave, b * subSize, Math.min(subSize, waveRows - b * subSize));
      if (gen.extIds.length === 0) break;
      const routed = routeBatch(gen.extIds, active);
      const titleOf = new Map(gen.extIds.map((e, i) => [e, gen.titles[i]]));

      // paralel pe shard-uri + STREAMS_PER_SHARD fluxuri concurente per shard
      // (maschează latența WebSocket ~170ms — inserturile de 1000 rânduri
      // se suprapun pe conexiuni distincte din pool)
      const shardTasks = [...routed.entries()].map(async ([shardId, ids]) => {
        const shard = active.find((s) => s.id === shardId)!;
        const rows = ids.map((id) => ({ extId: id, title: titleOf.get(id)! }));
        for (let s = 0; s < STREAMS_PER_SHARD; s++) {
          const stream = rows.filter((_, idx) => idx % STREAMS_PER_SHARD === s);
          for (let i = 0; i < stream.length; i += CHUNK) {
            const chunk = stream.slice(i, i + CHUNK);
            const ret = await insertChunk(shard, chunk);
            insertedPerShard[shard.name] = (insertedPerShard[shard.name] || 0) + ret.length;
            for (const r of ret) {
              collectedMap.push({ extId: r.extId, id: r.id, shardId });
              const cur = ranges[shard.name];
              ranges[shard.name] = cur ? { min: Math.min(cur.min, r.id), max: Math.max(cur.max, r.id) } : { min: r.id, max: r.id };
            }
          }
        }
      });
      await Promise.all(shardTasks);
      insertedWave += gen.extIds.length;

      // GARDĂ ÎN CURS DE VAL (două condiții):
      //  1. date live depășesc bugetul SAFE_DATA
      //  2. fișierele proiectului se apropie de limita Neon 512 MB (53100)
      const usedNow = (await Promise.all(active.map((s) => dbSize(poolFor(s))))).reduce((a, b) => a + b, 0);
      if (insertedWave * marginalPerRow > SAFE_DATA || usedNow > HARD_FILE_LIMIT) {
        console.log(`\n  ⚠️ gardă stocare: live≈${(insertedWave * marginalPerRow / 1024 / 1024).toFixed(0)}MB, fișiere=${(usedNow / 1024 / 1024).toFixed(0)}MB — val se oprește la ${insertedWave.toLocaleString("ro-RO")} rânduri`);
        storageAbort = true;
      }
    }

    // hartă de rutare BATCH la final de val (ca producția, dar grupat)
    // — SĂRITĂ la val oprite de gardă (valul va fi purjat imediat; evită 53100)
    if (!storageAbort) {
      for (const shardId of new Set(collectedMap.map((m) => m.shardId))) {
        await upsertMapBatch(collectedMap.filter((m) => m.shardId === shardId).map((m) => ({ extId: m.extId, id: m.id })), shardId);
      }
    }

    totalProcessed += insertedWave;
    const wMs = Date.now() - wStart;
    const rps = insertedWave / (wMs / 1000);
    for (const [name, n] of Object.entries(insertedPerShard)) perShardCounts[name] = n;
    console.log(`OK — ${rps.toFixed(0)} rânduri/s • per shard: ${Object.entries(insertedPerShard).map(([n, c]) => `${n}=${c}`).join(", ")}`);

    // recalibrare marginală: creșterea fișierelor / rânduri introduse
    const sizesAfter = await Promise.all(active.map((s) => dbSize(poolFor(s))));
    const deltaBytes = sizesAfter.reduce((a, b) => a + b, 0) - sizesBefore.reduce((a, b) => a + b, 0);
    if (insertedWave > 0) {
      const byFiles = deltaBytes > 0 ? deltaBytes / insertedWave : 0;
      marginalPerRow = Math.max(MARGINAL_FLOOR, byFiles);
    }
    if (storageAbort) {
      // val oprit devreme → estimarea subevaluează costul real; majorăm marginea
      marginalPerRow = Math.max(marginalPerRow * 1.6, MARGINAL_FLOOR * 2);
    }

    // distribuție reală (count per shard)
    const dist: number[] = [];
    for (const shard of active) {
      const r = (await poolFor(shard).query(`SELECT count(*)::bigint AS n FROM content WHERE provider = $1`, [PROVIDER])) as { rows: { n: string }[] };
      dist.push(Number(r.rows[0].n));
    }
    const ratio = dist.length === 2 && Math.min(...dist) > 0 ? Math.max(...dist) / Math.min(...dist) : 1;
    console.log(`[val ${wave}] distribuție: ${dist.join(" / ")} (raport ${ratio.toFixed(2)}:1) • DB: ${(await Promise.all(active.map((s) => dbSize(poolFor(s))))).map((s) => (s / 1024 / 1024).toFixed(0) + "MB").join(" + ")}`);

    // validare căutare la densitatea live (doar în ultima val)
    let searchStats: { p50: number; p95: number; hits: number } | null = null;
    if (totalProcessed >= TOTAL_TARGET) {
      console.log(`[căutare la vârf] ${(dist.reduce((a, b) => a + b, 0)).toLocaleString("ro-RO")} rânduri LIVE pe ${active.length} shard-uri — 8 interogări origin (cache bypass)...`);
      const times: number[] = [];
      let hits = 0;
      for (let i = 0; i < 8; i++) {
        const term = `val ${wave} film #${(i * 37_000 + 7) % waveRows}`;
        const t = Date.now();
        const r = await searchLibrary(term, { limit: 10, region: "eu-central-1" });
        times.push(Date.now() - t);
        hits += r.hits.length;
      }
      times.sort((a, b) => a - b);
      searchStats = { p50: times[Math.floor(times.length / 2)], p95: times[Math.ceil(times.length * 0.95) - 1], hits };
      lastSearch = searchStats;
      console.log(`[căutare la vârf] P50 ${searchStats.p50}ms • P95 ${searchStats.p95}ms • ${hits} hit-uri totale (scatter-gather ${active.length} shard-uri)`);
    }

    // PURJARE val + vacuum (spațiul e refolosit de valul următor)
    const purgeStart = Date.now();
    for (const shard of active) {
      if (ranges[shard.name]) await purgeWave(shard, ranges[shard.name]);
    }
    await q(`DELETE FROM content_shard_map WHERE external_id LIKE '${PREFIX}:%'`);
    await q(`VACUUM ANALYZE content_shard_map`).catch(() => {});
    console.log(`[val ${wave}] purjare+vacuum: ${(Date.now() - purgeStart) / 1000}s`);

    // compactare fizică dacă fișierele s-au umflat (păstrăm headroom față de 512MB)
    const usedAfterPurge = (await Promise.all(active.map((s) => dbSize(poolFor(s))))).reduce((a, b) => a + b, 0);
    if (usedAfterPurge > COMPACT_THRESHOLD) {
      console.log(`[compactare] fișiere=${(usedAfterPurge / 1024 / 1024).toFixed(0)}MB > ${(COMPACT_THRESHOLD / 1024 / 1024).toFixed(0)}MB — VACUUM FULL...`);
      await compactAll(active);
    }

    state.waves.push({ wave, inserted: insertedWave, perShard: insertedPerShard, ranges, ms: wMs });
    state.totalProcessed = totalProcessed;
    saveState(state);
    wave++;
  }

  const totalMs = Date.now() - t0;
  // vârf simultan real = cea mai mare val introdusă (fiecare val e purjată
  // înainte de următoarea — plafonul de stocare al planului sandbox)
  const peakWave = state.waves.reduce((m, w) => Math.max(m, w.inserted), 0);
  const result = {
    at: new Date().toISOString(),
    totalProcessed,
    peakSimultaneous: peakWave,
    waves: state.waves.length,
    shardsUsed,
    bytesPerRow: Math.round(calPerRow),
    distributionRatio: 0,
    searchP50Ms: 0,
    searchP95Ms: 0,
    durationS: Math.round(totalMs / 1000),
  };

  // statisticile finale din ultima val
  const last = state.waves[state.waves.length - 1];
  if (last) {
    const counts = Object.values(last.perShard).filter((n) => n > 0);
    if (counts.length === 2) result.distributionRatio = Math.round((Math.max(...counts) / Math.min(...counts)) * 100) / 100;
  }

  writeFileSync(RESULT_FILE, JSON.stringify({ ...result, searchP50Ms: lastSearch?.p50 ?? 0, searchP95Ms: lastSearch?.p95 ?? 0, searchHitsTotal: lastSearch?.hits ?? 0 }, null, 2));
  console.log(`\n✅ INGEST COMPLET: ${totalProcessed.toLocaleString("ro-RO")} rânduri PROCESATE în ${result.waves} valuri • ${(totalMs / 1000).toFixed(0)}s • căutare la vârf P50 ${lastSearch?.p50 ?? "—"}ms • rezultat în ${RESULT_FILE}`);

  // jurnal permanent în Neon (cu căutarea măsurată la vârf)
  await admin.query(
    `INSERT INTO ingest_scale_log (total_rows, peak_live, waves, shards_used, throughput_rps, distribution, search_p50_ms, search_p95_ms, duration_s, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [totalProcessed, result.peakSimultaneous, result.waves, shardsUsed, totalProcessed / (totalMs / 1000), JSON.stringify(result), lastSearch?.p50 ?? null, lastSearch?.p95 ?? null, Math.round(totalMs / 1000), "Faza 16b — valuri adaptate la plafonul de stocare sandbox (512MB/proiect, 53100 verifyat)"]
  ).catch(() => {});

  // restaurăm starea shard-ului remote (disabled, ca după Faza 15)
  if (remoteReg && remoteRestoredState) {
    await admin.query(`UPDATE shards SET state = $2 WHERE id = $1`, [remoteReg.id, remoteRestoredState]);
    invalidateShardRegistry();
    console.log(`[stare] ${remoteReg.name} restaurat pe "${remoteRestoredState}"`);
  }
}

// ============================================================
async function cleanup() {
  console.log("CURĂȚENIE TOTALĂ ingest la scară...");
  const all = await getShards(true);
  for (const shard of all) {
    try {
      const pool = shard.kind === "local" ? admin : new Pool({ connectionString: shard.dsn as string, max: 2 });
      const r = (await pool.query(`DELETE FROM content WHERE provider = $1`, [PROVIDER])) as { rowCount: number | null };
      console.log(`  ${shard.name}: ${r.rowCount ?? 0} rânduri șterse`);
      await pool.query(`VACUUM ANALYZE content`);
      if (shard.kind !== "local") await pool.end();
    } catch (e) {
      console.error(`  ${shard.name}: ${String((e as { message?: string })?.message || e).slice(0, 120)}`);
    }
  }
  await admin.query(`DELETE FROM content_shard_map WHERE external_id LIKE '${PREFIX}:%'`);
  await admin.query(`VACUUM ANALYZE content_shard_map`).catch(() => {});
  // restaurăm shard_b pe disabled (starea lăsată de Faza 15)
  const remoteReg = all.find((s) => s.kind === "remote");
  if (remoteReg) {
    await admin.query(`UPDATE shards SET state = 'disabled' WHERE id = $1`, [remoteReg.id]);
  }
  invalidateShardRegistry();
  // verificare finală
  const rem = await qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content WHERE provider = $1`, [PROVIDER]);
  const sz = await dbSize(admin);
  console.log(`✅ Curățenie completă: ${rem?.n} rânduri scale16 rămase pe primar • DB primar ${(sz / 1024 / 1024).toFixed(0)}MB`);
  if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, JSON.stringify({ waves: [], totalProcessed: 0 }));
}

(PHASE === "cleanup" ? cleanup() : run())
  .then(async () => { await admin.end().catch(() => {}); process.exit(0); })
  .catch(async (e) => {
    console.error("EȘEC INGEST:", e);
    await admin.end().catch(() => {});
    process.exit(1);
  });
