// Initialize Neon Postgres schema over WebSocket (persistent session, single compute)
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import { readFileSync } from "fs";

neonConfig.webSocketConstructor = WebSocket;
const url = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url });
const client = await pool.connect();

const script = readFileSync("/home/z/my-project/scripts/init.sql", "utf-8");
const statements = script
  .split(";")
  .map((s) => s.replace(/^--[^\n]*\n?/gm, "").trim())
  .filter((s) => s.length > 0)
  .filter((s) => !/^CREATE SCHEMA/i.test(s));

let ok = 0, skip = 0;
for (const query of statements) {
  try {
    await client.query(query);
    ok++;
  } catch (e: unknown) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      skip++;
    } else {
      console.error("ERR:", query.slice(0, 80).replace(/\n/g, " "), "->", msg.slice(0, 120));
    }
  }
}
console.log(`Done: ${ok} applied, ${skip} skipped`);

const tables = await client.query(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
);
console.log("All tables:", tables.rows.map((t: { tablename: string }) => t.tablename).join(", "));

// cleanup probe tables
for (const p of ["_probe_test", "_probe2", "_probe3"]) {
  try { await client.query(`DROP TABLE IF EXISTS "${p}"`); } catch {}
}

client.release();
await pool.end();
