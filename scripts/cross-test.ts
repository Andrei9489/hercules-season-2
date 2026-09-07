import { neon } from "@neondatabase/serverless";
const POOL = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const DIRECT = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const mode = process.argv[2];
if (mode === "write") {
  const sql = neon(POOL);
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS _probe2 (id int, ts timestamptz default now())`);
  await sql.unsafe(`INSERT INTO _probe2 (id) VALUES (2)`);
  const c = await sql`SELECT count(*)::int as n FROM _probe2`;
  const lsn = await sql`SELECT pg_current_wal_lsn()::text as lsn`;
  console.log("WRITE via POOL ok, rows now:", c[0].n, "LSN:", lsn[0].lsn);
} else if (mode === "read-direct") {
  const sql = neon(DIRECT);
  try {
    const c = await sql`SELECT count(*)::int as n FROM _probe2`;
    console.log("READ via DIRECT: rows =", c[0].n);
  } catch (e) { console.log("READ via DIRECT ERR:", String(e).slice(0, 120)); }
} else if (mode === "read-pool") {
  const sql = neon(POOL);
  try {
    const c = await sql`SELECT count(*)::int as n FROM _probe2`;
    console.log("READ via POOL: rows =", c[0].n);
  } catch (e) { console.log("READ via POOL ERR:", String(e).slice(0, 120)); }
}
