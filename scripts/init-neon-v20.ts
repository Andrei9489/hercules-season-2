// FAZA 20b — inițializare idempotentă DDL v20 (strat social în Neon)
import { readFileSync } from "node:fs";
import { Pool } from "@neondatabase/serverless";

const url = (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
  ? process.env.NEON_DATABASE_URL
  : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

async function main() {
  const sql = readFileSync("scripts/neon-v20.sql", "utf8");
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^--[^\n]*\n/gm, "").trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  const pool = new Pool({ connectionString: url, max: 1 });
  let okCount = 0;
  for (const st of statements) {
    try {
      await pool.query(st);
      okCount++;
    } catch (e) {
      console.error("EȘEC statement:", String(e).slice(0, 200), "\n→", st.slice(0, 120));
      process.exitCode = 1;
    }
  }
  console.log(`DDL v20: ${okCount}/${statements.length} statemente OK`);

  const chk = await pool.query(
    `SELECT to_regclass('social_comment') AS comments,
            to_regclass('social_reaction') AS reactions,
            to_regclass('social_follow') AS follows,
            to_regclass('social_activity') AS activity,
            to_regclass('social_cache') AS cache`
  );
  console.log("Verificare:", chk.rows[0]);
  await pool.end();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
