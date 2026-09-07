import { neon } from "@neondatabase/serverless";
const url = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const sql = neon(url);
try {
  const r = await sql`SELECT count(*)::int as n FROM "User"`;
  console.log("User table OK, rows:", r[0].n);
} catch (e) {
  console.log("User table ERROR:", String(e).slice(0, 200));
}
try {
  const r = await sql`SELECT current_database() as db, current_schema() as schema, version() as v`;
  console.log("Connected to:", JSON.stringify(r[0]));
} catch (e) {
  console.log("Conn ERROR:", String(e).slice(0, 200));
}
