// Faza 7 — inițializare DDL AI Intelligence Suite în Neon
// Rulare: bun run scripts/init-neon-v6.ts
import { readFileSync } from "node:fs";
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const url =
  process.env.NEON_DATABASE_URL ||
  "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 3 });

const sql = readFileSync("/home/z/my-project/scripts/neon-v6.sql", "utf8");

// separăm statementele — fișierul v6 NU conține funcții plpgsql, split simplu pe ';'
const statements = sql
  .split(";")
  .map((s) => s.replace(/--[^\n]*/g, (m) => (m.includes("\n") ? "" : " ")).trim())
  .filter((s) => s.length > 0);

let ok = 0;
for (const st of statements) {
  try {
    await pool.query(st);
    ok++;
    console.log(`OK: ${st.slice(0, 72).replace(/\s+/g, " ")}…`);
  } catch (e) {
    console.error(`EROARE: ${(e as Error).message}\n  → ${st.slice(0, 120)}`);
    process.exitCode = 1;
  }
}

// verificare finală
const check = await pool.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema='public' AND table_name IN ('genres','content_genres','ai_jobs','ai_insights')
   ORDER BY table_name`
);
console.log(`\n${ok}/${statements.length} statemente OK. Tabele AI: ${check.rows.map((r) => r.table_name).join(", ")}`);
await pool.end();
