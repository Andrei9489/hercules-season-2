// ============================================================
// Faza 12 — CLEANUP final după E2E:
//  1. șterge itemii de test + loguri/cache/istoric de test
//  2. DROP content_old + playback_events_old (după re-verificare secvențe!)
//  3. VACUUM FULL → recuperează spațiul de la testul la scară (406MB → ~20MB)
//  4. verificare finală: content=0, partiții 64+16, secvențe funcționale
// Rulează: bun scripts/cleanup-v12.ts
// ============================================================
import { Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
(require("@neondatabase/serverless") as { neonConfig: { webSocketConstructor: unknown } }).neonConfig.webSocketConstructor = WebSocket;

const DB_URL = process.env.NEON_DATABASE_URL || "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: DB_URL, max: 2, statement_timeout: 300_000 });

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await pool.query(sql)).rows as T[];
}
async function exec(sql: string): Promise<void> {
  await pool.query(sql);
}

async function main() {
  console.log("=== FAZA 12: CLEANUP ===\n");

  // 1. curățenie conținut + evenimente + cache/loguri de test
  await exec(`DELETE FROM playback_events`);
  await exec(`DELETE FROM content`);
  await exec(`DELETE FROM search_cache`);
  await exec(`DELETE FROM search_logs`);
  await exec(`DELETE FROM search_stats`);
  await exec(`DELETE FROM "History"`);
  await exec(`DELETE FROM playback_events`);
  console.log("Șters: content, playback_events, search_cache, search_logs, search_stats, history (de test)");

  // 2. re-verificare secvențe ÎNAINTE de drop (crítica!)
  const seqCheck = await q<{ owned: boolean }>(`
    SELECT EXISTS(
      SELECT 1 FROM pg_depend d
      JOIN pg_class s ON s.oid = d.objid AND s.relname = 'content_id_seq'
      JOIN pg_class t ON t.oid = d.refobjid AND t.relname = 'content'
      WHERE d.deptype IN ('a', 'i')
    ) AS owned`);
  if (!seqCheck[0].owned) {
    console.log("SECVENȚĂ NE-ASIGNATĂ la content — re-asignez acum");
    await exec(`ALTER SEQUENCE content_id_seq OWNED BY content.id`);
  }
  await exec(`ALTER SEQUENCE playback_events_id_seq OWNED BY playback_events.id`);
  console.log("Secvențe re-verificate: OWNED BY noile tabele");

  // 3. DROP tabele vechi (rollback window se închide)
  await exec(`DROP TABLE IF EXISTS content_old CASCADE`);
  await exec(`DROP TABLE IF EXISTS playback_events_old CASCADE`);
  console.log("DROP: content_old, playback_events_old (cu cele 16+4 partiții legacy)");

  // secvențele trebuie să supraviețuiască drop-ului
  const seq = await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_class WHERE relname IN ('content_id_seq','playback_events_id_seq')`);
  if (Number(seq[0].n) !== 2) throw new Error("SECVENȚELE AU DISPĂRUT — oprire!");
  console.log(`Secvențe supraviețuitoare: ${seq[0].n}/2`);

  // 4. VACUUM FULL (recuperează spațiul; fără tranzacție)
  console.log("VACUUM FULL content (64 partiții + indexuri)…");
  await exec(`VACUUM FULL content`);
  await exec(`VACUUM FULL playback_events`);
  await exec(`VACUUM FULL search_logs`);
  await exec(`VACUUM search_cache`);
  await exec(`VACUUM suggest_rollup`);
  console.log("VACUUM FULL complet");

  // 5. verificare finală + test funcțional insert/delete pe secvență
  const t0 = Date.now();
  const ins = await q<{ id: string }>(`
    INSERT INTO content (external_id, title, content_type, provider, source_type, search_text)
    VALUES ('__f12_final_check__', 'Verificare Finală', 'video', 'test', 'url', 'verificare finala faza 12')
    RETURNING id::text`);
  await exec(`DELETE FROM content WHERE external_id = '__f12_final_check__'`);
  console.log(`Test secvență+routare post-cleanup: id=${ins[0].id} în ${Date.now() - t0}ms OK`);

  const fin = await q<{ content: string; pb: string; parts: string; sz: string }>(`
    SELECT (SELECT count(*)::text FROM content) AS content,
           (SELECT count(*)::text FROM playback_events) AS pb,
           (SELECT count(*)::text FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhparent WHERE c.relname IN ('content','playback_events')) AS parts,
           pg_size_pretty(pg_database_size(current_database()))::text AS sz`);
  console.log(`\nFINAL: content=${fin[0].content} • playback=${fin[0].pb} • partiții=${fin[0].parts} • DB ${fin[0].sz}`);

  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); pool.end().finally(() => process.exit(1)); });
