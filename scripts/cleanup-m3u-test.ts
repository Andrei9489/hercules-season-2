// Curățare date de test M3U (Faza 9) — biblioteca rămâne la 0, user-driven
import { q, qOne } from "../src/lib/pg";

async function main() {
  const before = await qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content`);
  console.log("înainte:", before?.n);

  await q(`DELETE FROM content WHERE external_id LIKE 'm3u:%'`);
  await q(`DELETE FROM search_cache`);
  await q(`DELETE FROM search_logs`);
  await q(`DELETE FROM search_stats`);
  await q(`DELETE FROM playback_events`);

  const after = await qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content`);
  console.log("după:", after?.n);
  process.exit(Number(after?.n) === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
