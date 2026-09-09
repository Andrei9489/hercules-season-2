// FAZA 16 — inițializare: regions (multi-region EU/US/APAC) + manage_log (audit
// ștergeri) + ingest_scale_log (dovadă ingest la scară). Idempotent: SIGUR de re-rulat.
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
  const raw = readFileSync("/home/z/my-project/scripts/neon-v16.sql", "utf8");
  const stmts = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Execut ${stmts.length} statemente DDL v16...`);
  for (const [i, s] of stmts.entries()) {
    await pool.query(s);
    console.log(`  [${i + 1}/${stmts.length}] OK`);
  }

  const regions = await pool.query(
    `SELECT code, name, region_group, role, env_var, state FROM regions ORDER BY id`
  );
  console.log("Regiuni în registry:");
  for (const r of regions.rows) {
    console.log(`  ${r.code} [${r.role}] ${r.name} — ${r.state}${r.env_var ? ` (env: ${r.env_var})` : ""}`);
  }
  console.log("✅ DDL v16 complet.");
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error("EȘEC DDL v16:", e.message);
    process.exitCode = 1;
    return pool.end();
  });
