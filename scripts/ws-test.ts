// Test WS mode: persistent session, single compute
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket;
const url = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const mode = process.argv[2] || "write";

const pool = new Pool({ connectionString: url });
const client = await pool.connect();
try {
  if (mode === "write") {
    await client.query(`CREATE TABLE IF NOT EXISTS _probe3 (id int, ts timestamptz default now())`);
    await client.query(`INSERT INTO _probe3 (id) VALUES (3)`);
    const r = await client.query(`SELECT count(*)::int as n FROM _probe3`);
    console.log("WS WRITE ok, rows:", r.rows[0].n);
  } else {
    const r = await client.query(`SELECT count(*)::int as n, max(ts) as last FROM _probe3`);
    console.log("WS READ rows:", r.rows[0].n, "last:", r.rows[0].last);
  }
} catch (e) {
  console.log(`WS ${mode} ERR:`, String(e).slice(0, 200));
} finally {
  client.release();
  await pool.end();
}
