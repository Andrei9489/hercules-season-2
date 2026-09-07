// ============================================================
// Faza 5 — Aplică DDL v4 pe Neon: index covering pentru suggest
// + VACUUM/ANALYZE (visibility map pentru index-only scans).
// Rulează: bun scripts/init-neon-v4.ts
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import dns from "node:dns";
import fs from "node:fs";

try { dns.setDefaultResultOrder("ipv4first"); } catch { /* noop */ }
neonConfig.webSocketConstructor = WebSocket;

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url });

async function main() {
  const sql = fs.readFileSync("scripts/neon-v4.sql", "utf8");
  const stmts = sql
    .split(";")
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean);

  let ok = 0;
  for (const s of stmts) {
    try {
      await pool.query(s);
      ok++;
      console.log(`OK: ${s.slice(0, 80)}...`);
    } catch (e) {
      console.error(`FAIL: ${String(e).slice(0, 300)}`);
    }
  }
  console.log(`DDL v4: ${ok}/${stmts.length} instrucțiuni OK`);

  // VACUUM pe parent procesează toate partițiile (PG13+) — setează
  // visibility map, obligatoriu pentru index-only scans.
  const t0 = Date.now();
  await pool.query(`VACUUM (ANALYZE) content`);
  await pool.query(`VACUUM (ANALYZE) search_cache`);
  console.log(`VACUUM ANALYZE content + search_cache OK în ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Verificare: index-ul covering există pe fiecare partiție
  const r = await pool.query(
    `SELECT count(DISTINCT tablename)::int AS n FROM pg_indexes
     WHERE indexname = 'idx_content_suggest'`
  );
  console.log(`idx_content_suggest prezent pe ${r.rows[0].n} tabele (parent + partiții)`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
