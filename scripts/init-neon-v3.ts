// Faza 4 — aplică DDL neon-v3.sql (L2 cache distribuit) în Neon
import { readFileSync } from "node:fs";
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const url = (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
  ? process.env.NEON_DATABASE_URL!
  : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 2 });

const ddl = readFileSync("scripts/neon-v3.sql", "utf8");
const statements = ddl
  .split(";")
  .map((s) => s.replace(/--.*$/gm, "").trim())
  .filter((s) => s.length > 0);

let ok = 0;
for (const stmt of statements) {
  try {
    await pool.query(stmt);
    ok++;
  } catch (e) {
    console.error("Eroare DDL:", String(e), "\n→", stmt.slice(0, 120));
  }
}
console.log(`Faza 4 DDL: ${ok}/${statements.length} instrucțiuni OK`);

// verificare
const chk = await pool.query(
  `SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'search_cache'`
);
console.log("Tabel search_cache există:", chk.rows[0].n === 1);
await pool.end();
