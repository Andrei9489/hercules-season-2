// Verificare pre-expansiune Faza 12: structura content/playback_events,
// dependențe (views, FK, funcții), dimensiune DB — înainte de swap x16→x64.
import { Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfigFix();
function neonConfigFix() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require("@neondatabase/serverless") as { neonConfig: { webSocketConstructor: unknown } }).neonConfig.webSocketConstructor = WebSocket;
}

const DB_URL = process.env.NEON_DATABASE_URL || "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 10_000 });

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const r = await pool.query(sql);
  return r.rows as T[];
}

async function main() {
  const [
    cols, idxs, parts, views, fks, funcs, size, pbParts, pbIdx,
  ] = await Promise.all([
    q<{ column_name: string; data_type: string; is_generated: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_generated, column_default FROM information_schema.columns WHERE table_name='content' ORDER BY ordinal_position`),
    q<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='content' ORDER BY indexname`),
    q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_inherits WHERE inhparent='content'::regclass`),
    q<{ viewname: string }>(`SELECT viewname FROM pg_views WHERE definition ILIKE '%content%'`),
    q<{ conname: string; conrelid: string }>(`
      SELECT conname, c.relname::text AS conrelid FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      WHERE confrelid = 'content'::regclass`),
    q<{ proname: string }>(`
      SELECT DISTINCT p.proname FROM pg_proc p
      JOIN pg_depend d ON d.refobjid = 'content'::regclass AND d.objid = p.oid`),
    q<{ sz: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS sz`),
    q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_inherits WHERE inhparent='playback_events'::regclass`),
    q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_indexes WHERE tablename LIKE 'playback_events%'`),
  ]);

  console.log("=== CONTENT: coloane ===");
  for (const c of cols) console.log(`  ${c.column_name} ${c.data_type}${c.is_generated === 'Y' ? ' GENERATED' : ''}${c.column_default ? ` DEFAULT ${c.column_default.slice(0, 50)}` : ''}`);
  console.log(`\n=== CONTENT: ${parts[0].n} partiții directe, ${idxs.length} indexuri pe parent ===`);
  for (const i of idxs) console.log(`  ${i.indexname}: ${i.indexdef.slice(0, 120)}`);
  console.log(`\n=== DEPENDENȚE ===`);
  console.log(`views care referă content: ${views.length ? views.map(v => v.viewname).join(", ") : "NICIUNA"}`);
  console.log(`FK către content: ${fks.length ? JSON.stringify(fks) : "NICIUNUL"}`);
  console.log(`funcții dependente de content (pg_depend): ${funcs.length ? funcs.map(f => f.proname).join(", ") : "niciuna direct"}`);
  console.log(`\nplayback_events: ${pbParts[0].n} partiții, ${pbIdx[0].n} indexuri totale`);
  console.log(`DB size: ${size[0].sz}`);

  // funcțiile care menționează 'content' în sursă (text)
  const srcFuncs = await q<{ proname: string }>(`
    SELECT DISTINCT proname FROM pg_proc WHERE prosrc ILIKE '%content%'`);
  console.log(`funcții cu 'content' în corp: ${srcFuncs.map(f => f.proname).join(", ")}`);

  await pool.end();
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
