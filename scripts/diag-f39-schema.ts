// Diagnostic Faza 39 — schema reală `content` în Neon (cauza erorii „Postere")
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const pool = new Pool({
  connectionString:
    "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require",
  max: 2,
});

async function main() {
const cols = await pool.query(
  `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name='content' ORDER BY ordinal_position`
);
console.log("CONTENT COLUMNS:", JSON.stringify(cols.rows.map((r) => r.column_name)));

const cnt = await pool.query(`SELECT count(*)::int AS n FROM content`);
console.log("CONTENT COUNT:", cnt.rows[0].n);

// exact interogarea din /api/manage?tab=posters
try {
  const probe = await pool.query(
    `SELECT id, title, content_type, provider, thumbnail, backdrop, year,
            popularity, views, created_at
     FROM content ORDER BY id DESC LIMIT 3`
  );
  console.log("POSTERS SQL OK — rows:", probe.rows.length);
} catch (e) {
  console.log("POSTERS SQL FAILS:", String(e).slice(0, 300));
}

// interogarea tab=content
try {
  const probe2 = await pool.query(
    `SELECT id, external_id, title, content_type, provider, source_type,
            source_url, thumbnail, year, popularity, views, created_by, created_at
     FROM content ORDER BY id DESC LIMIT 3`
  );
  console.log("CONTENT SQL OK — rows:", probe2.rows.length);
} catch (e) {
  console.log("CONTENT SQL FAILS:", String(e).slice(0, 300));
}

await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error("DIAG FAIL:", e); process.exit(1); });
