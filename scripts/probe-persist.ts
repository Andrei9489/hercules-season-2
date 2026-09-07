import { neon } from "@neondatabase/serverless";
const url = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const sql = neon(url);
const cmd = process.argv[2] || "create";
if (cmd === "create") {
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS _probe_test (id int, ts timestamptz default now())`);
    await sql.unsafe(`INSERT INTO _probe_test (id) VALUES (1)`);
    console.log("CREATE+INSERT done");
  } catch (e) { console.log("ERR:", String(e).slice(0, 150)); }
} else {
  try {
    const r = await sql`SELECT * FROM _probe_test ORDER BY id`;
    console.log("Probe rows:", JSON.stringify(r));
  } catch (e) { console.log("ERR:", String(e).slice(0, 150)); }
}
