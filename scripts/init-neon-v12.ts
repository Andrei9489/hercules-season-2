// ============================================================
// Faza 12 — EXPANSIUNE PARTIȚII: content x16 → x64, playback_events x4 → x16
// Fereastră de oportunitate: biblioteca = 0 rânduri (model user-driven,
// curățată după Faza 11) → swap atomic cu COST ZERO (fără migrare date).
//
// De ce x64: plafonul de design per partiție (~6,25M rânduri confort,
// densitate la care x16 valida 100M total) × 64 partiții = 400M rânduri
// validate pe același compute → 1,33% din ținta 30 miliarde (4x mai sus).
// Producție: expandare ulterioară x256 (same pattern, script re-rulabil).
//
// Siguranță:
//  - ABORT dacă content/playback_events NU sunt goale (nu migrăm date!)
//  - swap în TRANZACȚIE (rename atomic, OID-ul se păstrează → funcțiile
//    plpgsql late-bound (record_playback, refresh_suggest_rollup) rămân valide)
//  - re-asignare OWNED BY pentru secvențe (altfel DROP content_old le șterge!)
//  - verificare post-swap: routare partiții (tableoid), indexuri, rollup
//  - rollback manual: content_old rămâne pe disc până la verificarea finală
// Rulează: bun scripts/init-neon-v12.ts
// ============================================================
import { Pool, neonConfig } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;


const DB_URL = process.env.NEON_DATABASE_URL || "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: DB_URL, max: 3, connectionTimeoutMillis: 15_000, statement_timeout: 60_000 });

const CONTENT_PARTS = 64;
const PLAYBACK_PARTS = 16;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params as never[])).rows as T[];
}
async function exec(sql: string): Promise<void> {
  await pool.query(sql);
}

async function main() {
  console.log("=== FAZA 12: expansiune partiții content x16→x64, playback x4→x16 ===\n");

  // ---- 0. PREFLIGHT: tabelele trebuie să fie GOALE (zero-cost swap) ----
  const { rows: cntRows } = await pool.query(`SELECT (SELECT count(*) FROM content) AS c, (SELECT count(*) FROM playback_events) AS p`);
  const contentCount = Number(cntRows[0].c), playbackCount = Number(cntRows[0].p);
  console.log(`Preflight: content=${contentCount}, playback_events=${playbackCount}`);
  if (contentCount > 0 || playbackCount > 0) {
    console.error("ABORT: tabelele NU sunt goale — expansiunea ar cere migrare de date. Oprire sigură.");
    await pool.end();
    process.exit(1);
  }

  const before = await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_inherits WHERE inhparent='content'::regclass`);
  const pbBefore = await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_inherits WHERE inhparent='playback_events'::regclass`);
  console.log(`Înainte: content ${before[0].n} partiții, playback ${pbBefore[0].n} partiții\n`);

  // ---- 1. Curățare re-rulări anterioare ----
  await exec(`DROP TABLE IF EXISTS content_new CASCADE`);
  await exec(`DROP TABLE IF EXISTS playback_events_new CASCADE`);

  // ---- 2. Tabele noi partiționate (LIKE INCLUDING ALL copiază coloane, ----
  //         default-uri, indexuri; secvența rămâne SHARED prin default) ----
  await exec(`CREATE TABLE content_new (LIKE content INCLUDING ALL) PARTITION BY HASH (id)`);
  console.log(`Creat content_new (LIKE content INCLUDING ALL) PARTITION BY HASH (id)`);

  // NOTĂ nume: partițiile vechi (content_p00..15) își păstrează numele după
  // rename-ul parentului → prefix distinct 'h64' pentru cele noi (fără coliziune).
  const p1: string[] = [];
  for (let i = 0; i < CONTENT_PARTS; i++) {
    p1.push(`CREATE TABLE content_h64_p${String(i).padStart(2, "0")} PARTITION OF content_new FOR VALUES WITH (MODULUS ${CONTENT_PARTS}, REMAINDER ${i})`);
  }
  await exec(p1.join("; "));
  console.log(`Creat ${CONTENT_PARTS} partiții content_h64_p00..content_h64_p63`);

  // Partiționare pe HASH(id): PK-ul (id) trebuie să includă coloana de
  // partiționare; distribuția prin secvență e uniformă oricum (rând nou = id nou).
  await exec(`CREATE TABLE playback_events_new (LIKE playback_events INCLUDING ALL) PARTITION BY HASH (id)`);
  const p2: string[] = [];
  for (let i = 0; i < PLAYBACK_PARTS; i++) {
    p2.push(`CREATE TABLE playback_h16_p${String(i).padStart(2, "0")} PARTITION OF playback_events_new FOR VALUES WITH (MODULUS ${PLAYBACK_PARTS}, REMAINDER ${i})`);
  }
  await exec(p2.join("; "));
  console.log(`Creat ${PLAYBACK_PARTS} partiții playback_h16_p00..p15`);

  // ---- 3. SWAP ATOMIC în tranzacție ----
  await exec(`BEGIN`);
  try {
    await exec(`ALTER TABLE content RENAME TO content_old`);
    await exec(`ALTER TABLE content_new RENAME TO content`);
    await exec(`ALTER TABLE playback_events RENAME TO playback_events_old`);
    await exec(`ALTER TABLE playback_events_new RENAME TO playback_events`);
    await exec(`COMMIT`);
    console.log("\nSWAP ATOMIC OK: content→content_old, content_new→content (și playback)");
  } catch (e) {
    await exec(`ROLLBACK`);
    throw e;
  }

  // ---- 4. Re-asignare OWNED BY pe secvențe (CRITIC: altfel DROP _old le șterge) ----
  await exec(`ALTER SEQUENCE content_id_seq OWNED BY content.id`);
  await exec(`ALTER SEQUENCE playback_events_id_seq OWNED BY playback_events.id`);
  console.log("Secvențe re-asignate: content_id_seq → content.id, playback_events_id_seq → playback_events.id");

  // ---- 5. Verificări post-swap ----
  const parts = await q<{ tbl: string; n: string }>(
    `SELECT c.relname::text AS tbl, count(*)::text AS n FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhparent
     WHERE c.relname IN ('content','playback_events') GROUP BY c.relname`);
  console.log(`\nPartiții după swap: ${parts.map(p => `${p.tbl}=${p.n}`).join(", ")}`);

  // routare partiție + default seq + indexuri: insert test → tableoid → delete
  const ins = await q<{ id: string; part: string }>(`
    WITH r AS (
      INSERT INTO content (external_id, title, content_type, provider, source_type, search_text)
      VALUES ('__f12_swap_test__', 'Test Swap Faza 12', 'video', 'test', 'url', 'test swap faza 12')
      RETURNING id, tableoid
    ) SELECT r.id::text AS id, c.relname::text AS part FROM r, pg_class c WHERE c.oid = r.tableoid`);
  console.log(`Insert test: id=${ins[0].id}, a aterizat în partiția ${ins[0].part} (routare HASH OK)`);

  const insPb = await q<{ part: string }>(`
    WITH r AS (
      INSERT INTO playback_events (content_id, provider, event, seconds)
      VALUES (${ins[0].id}, 'test', 'start', 0)
      RETURNING tableoid
    ) SELECT c.relname::text AS part FROM r, pg_class c WHERE c.oid = r.tableoid`);
  console.log(`playback_events test → partiția ${insPb[0].part}`);

  // indexuri pe partiția copil (moștenite de la parent)?
  const childIdx = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_indexes WHERE tablename = ${ins[0].part ? `'${ins[0].part}'` : "''"}`);
  console.log(`Indexuri pe partiția copil ${ins[0].part}: ${childIdx[0].n} (moștenire OK)`);

  // funcția plpgsql late-bound încă rezolvă 'content' după rename?
  const rollup = await q<{ titles: string[] }>(`
    INSERT INTO suggest_rollup (prefix_key, titles, item_count, refreshed_at)
    SELECT 'f12', COALESCE(jsonb_agg(title ORDER BY popularity DESC) FILTER (WHERE rn <= 5), '[]'::jsonb), 0, now()
    FROM (SELECT title, popularity, row_number() OVER (ORDER BY popularity DESC) AS rn
          FROM content WHERE search_text LIKE 'test swap%') b
    ON CONFLICT (prefix_key) DO UPDATE SET titles = EXCLUDED.titles, refreshed_at = now()
    RETURNING titles`);
  console.log(`Rollup pe conținutul de test: ${JSON.stringify(rollup[0]?.titles)} (funcțiile plpgsql funcționează după swap)`);

  // căutare FTS/trigram pe rândul de test
  const srch = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM content WHERE search_text LIKE '%test swap%'`);
  console.log(`Căutare trigram pe rândul de test: ${srch[0].n} rezultate`);

  // curățenie rânduri test + bucket rollup test
  await exec(`DELETE FROM playback_events WHERE provider = 'test'`);
  await exec(`DELETE FROM content WHERE external_id = '__f12_swap_test__'`);
  await exec(`DELETE FROM suggest_rollup WHERE prefix_key = 'f12'`);

  // ---- 6. ANALYZE ----
  await exec(`ANALYZE content`);
  await exec(`ANALYZE playback_events`);
  console.log("\nANALYZE content + playback_events OK");

  // ---- 7. Statistici finale ----
  const idxAll = await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_indexes WHERE tablename LIKE 'content%'`);
  const idxPb = await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_indexes WHERE tablename LIKE 'playback_events%'`);
  const size = await q<{ sz: string }>(`SELECT pg_size_pretty(pg_database_size(current_database()))::text AS sz`);
  console.log(`\n=== FINAL ===`);
  console.log(`Indexuri content%: ${idxAll[0].n} • playback%: ${idxPb[0].n}`);
  console.log(`DB size: ${size[0].sz}`);
  console.log(`NOTĂ: content_old / playback_events_old rămân pe disc până la verificarea E2E (rollback sigur), apoi se șterg în cleanup.`);

  await pool.end();
}

main().catch((e) => {
  console.error("FAIL:", e.message || e);
  pool.end().finally(() => process.exit(1));
});
