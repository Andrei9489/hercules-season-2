// curăță cache-ul de recomandări (utilizare: npx tsx scripts/clear-rec-cache-f18.ts)
import { Pool } from "@neondatabase/serverless";
const p = new Pool({ connectionString: "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require", max: 1 });
async function main() {
  const r = await p.query("DELETE FROM ai_recommend_cache WHERE cache_key LIKE 'rec:%'");
  console.log("cache șters:", r.rowCount);
  await p.end();
}
main().catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1); });
