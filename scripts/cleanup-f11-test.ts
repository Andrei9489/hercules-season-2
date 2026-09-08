// Faza 11 — curățare date de test după verificarea E2E
// (modelul platformei: biblioteca e umplută DOAR de utilizator)
// Rulare: bun run scripts/cleanup-f11-test.ts
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const url =
  process.env.NEON_DATABASE_URL ||
  "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 3 });

// 1) colecțiile de test (+ legăturile)
const dc = await pool.query(`DELETE FROM collections WHERE name = 'Știri și Actualitate' RETURNING id`);
console.log(`Colecții șterse: ${dc.rowCount}`);
const dci = await pool.query(`DELETE FROM collection_items WHERE collection_id NOT IN (SELECT id FROM collections)`);
console.log(`Legături orfane curățate: ${dci.rowCount}`);

// 2) itemii de test din bibliotecă (cele 3 surse demo adăugate azi)
const dlib = await pool.query(
  `DELETE FROM content WHERE external_id LIKE 'user:%' AND id IN (
     SELECT id FROM content WHERE external_id LIKE 'user:%'
       AND (title ILIKE '%Big Buck%' OR title ILIKE '%Mux%' OR title ILIKE '%Bigger Blazes%')
   ) RETURNING id`
);
console.log(`Itemi bibliotecă șterși: ${dlib.rowCount}`);

// 3) istoricul de test (progres) + evenimente redare + loguri/cache
const dh = await pool.query(`DELETE FROM "History"`);
console.log(`Istoric șters: ${dh.rowCount}`);
const dpe = await pool.query(`DELETE FROM playback_events`);
console.log(`playback_events șterse: ${dpe.rowCount}`);
const dsl = await pool.query(`DELETE FROM search_logs`);
console.log(`search_logs șterse: ${dsl.rowCount}`);
const dsc = await pool.query(`DELETE FROM search_cache`);
console.log(`search_cache șterse: ${dsc.rowCount}`);

// 4) verificare finală
const chk = await pool.query(`
  SELECT
    (SELECT count(*) FROM content) AS content,
    (SELECT count(*) FROM collections) AS collections,
    (SELECT count(*) FROM collection_items) AS collection_items,
    (SELECT count(*) FROM "History") AS history,
    (SELECT count(*) FROM "User") AS users
`);
const r = chk.rows[0];
console.log(`\nFINAL: content=${r.content} • collections=${r.collections} • collection_items=${r.collection_items} • history=${r.history} • users=${r.users} (păstrați)`);
await pool.end();
