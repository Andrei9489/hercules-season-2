// FAZA 14 — inițializare tabele Neon Sync (sync_log + sync_seen) în Neon
// Idempotent: SIGUR de re-rulat.
import { readFileSync } from "node:fs";
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 2 });

async function main() {
  const raw = readFileSync("/home/z/my-project/scripts/neon-v14.sql", "utf8");
  // împarte pe ';' la final de linie (comentariile cu ';' în interior sunt pe linii proprii — eliminate mai jos)
  const stmts = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Execut ${stmts.length} statemente DDL v14...`);
  for (const [i, s] of stmts.entries()) {
    await pool.query(s);
    console.log(`  [${i + 1}/${stmts.length}] OK`);
  }

  // verificare
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name IN ('sync_log','sync_seen') ORDER BY 1`
  );
  console.log("Tabele sync prezente:", tables.rows.map((r) => r.table_name).join(", "));

  const log = await pool.query(`SELECT count(*)::int AS n FROM sync_log`);
  const seen = await pool.query(`SELECT count(*)::int AS n FROM sync_seen`);
  console.log(`sync_log: ${log.rows[0].n} rânduri • sync_seen: ${seen.rows[0].n} rânduri`);
  console.log("✅ DDL v14 complet.");
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error("EȘEC DDL v14:", e.message);
    process.exitCode = 1;
    return pool.end();
  });
