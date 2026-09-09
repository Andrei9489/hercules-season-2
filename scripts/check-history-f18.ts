// FAZA 18 — verificare rapidă: coloane reale History pe Neon + funcționalitatea recomandărilor actuale
import { Pool } from "@neondatabase/serverless";

const url = (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
  ? process.env.NEON_DATABASE_URL
  : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 2 });

async function main() {
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='History' ORDER BY ordinal_position`
  );
  console.log("History cols (Neon):", cols.rows.map((r) => r.column_name).join(", "));

  const watchlist = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='Watchlist' ORDER BY ordinal_position`
  );
  console.log("Watchlist cols:", watchlist.rows.map((r) => r.column_name).join(", "));

  const fav = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='Favorite' ORDER BY ordinal_position`
  );
  console.log("Favorite cols:", fav.rows.map((r) => r.column_name).join(", "));

  // testează interogarea EXACTĂ din recommendForUser actual
  try {
    const r = await pool.query(
      `SELECT DISTINCT h.media_id FROM "History" h WHERE h.user_id = $1 AND h.media_id ~ '^[0-9]+$' ORDER BY h.media_id DESC LIMIT 12`,
      ["nobody@test"]
    );
    console.log("query snake_case OK:", r.rows.length, "rânduri");
  } catch (e) {
    console.log("query snake_case EȘUEAZĂ:", String(e).slice(0, 120));
  }

  const recCache = await pool.query(
    `SELECT to_regclass('ai_recommend_cache') AS t`
  );
  console.log("ai_recommend_cache există:", recCache.rows[0].t);

  await pool.end();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
