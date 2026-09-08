// Verificare trigger-e + funcții dinamice înainte de swap x16→x64
import { Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

(require("@neondatabase/serverless") as { neonConfig: { webSocketConstructor: unknown } }).neonConfig.webSocketConstructor = WebSocket;

const DB_URL = process.env.NEON_DATABASE_URL || "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 10_000 });

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await pool.query(sql)).rows as T[];
}

async function main() {
  const trig = await q(
    `SELECT event_object_table, trigger_name, action_timing, event_manipulation, action_statement
     FROM information_schema.triggers WHERE event_object_table IN ('content','playback_events')`);
  console.log("=== TRIGGER-E ===");
  for (const t of trig) console.log(`  ${t.event_object_table}.${t.trigger_name}: ${t.action_timing} ${t.event_manipulation}\n    → ${String(t.action_statement).slice(0, 150)}`);
  if (!trig.length) console.log("  (niciunul)");

  const fns = await q<{ proname: string; prosrc: string }>(
    `SELECT proname, prosrc FROM pg_proc WHERE proname IN ('create_content_partition_if_needed','get_content_partition_name','record_playback')`);
  for (const f of fns) {
    console.log(`\n=== FUNCȚIA ${f.proname} ===\n${f.prosrc.slice(0, 1200)}`);
  }

  // structura playback_events
  const pb = await q<{ column_name: string; data_type: string; column_default: string | null }>(
    `SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='playback_events' ORDER BY ordinal_position`);
  console.log("\n=== PLAYBACK_EVENTS coloane ===");
  for (const c of pb) console.log(`  ${c.column_name} ${c.data_type}${c.column_default ? ` DEF ${c.column_default.slice(0, 40)}` : ""}`);
  const pbParent = await q<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='playback_events'`);
  console.log("=== PLAYBACK_EVENTS indexuri parent ===");
  for (const i of pbParent) console.log(`  ${i.indexname}: ${i.indexdef.slice(0, 110)}`);

  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
