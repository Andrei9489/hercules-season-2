// Faza 11 — inițializare DDL colecții + mentenanță în Neon
// Rulare: bun run scripts/init-neon-v11.ts
import { readFileSync } from "node:fs";
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const url =
  process.env.NEON_DATABASE_URL ||
  "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 3 });

const sql = readFileSync("/home/z/my-project/scripts/neon-v11.sql", "utf8");

// separăm statementele — fișierul v11 NU conține funcții plpgsql.
// IMPORTANT: eliminăm comentariile pe linie ÎNTÂI (comentariile pot conține ';'
// — ex: „split pe ';' e sigur" — și ar rupe split-ul dacă ar rămâne).
const statements = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
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
   WHERE table_schema='public' AND table_name IN ('collections','collection_items')
   ORDER BY table_name`
);
const parts = await pool.query(
  `SELECT count(*)::int AS n FROM pg_inherits i
   JOIN pg_class c ON c.oid = i.inhrelid
   JOIN pg_class p ON p.oid = i.inhparent
   WHERE p.relname = 'search_logs'`
);
console.log(
  `\n${ok}/${statements.length} statemente OK. Tabele Faza 11: ${check.rows.map((r) => r.table_name).join(", ")} • partiții search_logs: ${parts.rows[0]?.n}`
);
await pool.end();
