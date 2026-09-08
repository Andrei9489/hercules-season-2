// FAZA 15 — inițializare sharding multi-compute (shards + content_shard_map +
// shard_health_log) în Neon. Idempotent: SIGUR de re-rulat.
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
  const raw = readFileSync("/home/z/my-project/scripts/neon-v15.sql", "utf8");
  const stmts = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Execut ${stmts.length} statemente DDL v15...`);
  for (const [i, s] of stmts.entries()) {
    await pool.query(s);
    console.log(`  [${i + 1}/${stmts.length}] OK`);
  }

  const shards = await pool.query(
    `SELECT id, name, kind, region, weight, state, max_rows FROM shards ORDER BY id`
  );
  console.log("Shard-uri în registry:");
  for (const s of shards.rows) {
    console.log(`  #${s.id} ${s.name} [${s.kind}] ${s.region} w=${s.weight} ${s.state} plafon=${s.max_rows}`);
  }
  console.log("✅ DDL v15 complet.");
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error("EȘEC DDL v15:", e.message);
    process.exitCode = 1;
    return pool.end();
  });
