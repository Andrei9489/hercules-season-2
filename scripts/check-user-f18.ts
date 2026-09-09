// verificare rapidă User cols + shards (Faza 18 setup)
import { Pool } from "@neondatabase/serverless";
const p = new Pool({ connectionString: process.env.NEON_DATABASE_URL || "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require", max: 1 });
async function main() {
  const u = await p.query("SELECT column_name FROM information_schema.columns WHERE table_name='User' ORDER BY ordinal_position");
  console.log("User cols:", u.rows.map((r) => r.column_name).join(","));
  const s = await p.query("SELECT id,name,kind,state FROM shards ORDER BY id");
  console.log("shards:", JSON.stringify(s.rows));
  await p.end();
}
main().catch((e) => { console.error(String(e).slice(0,300)); process.exit(1); });
