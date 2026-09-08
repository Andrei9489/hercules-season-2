// Diagnostic fan-out x64: Planning Time vs Execution Time pe densitate
import { Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
(require("@neondatabase/serverless") as { neonConfig: { webSocketConstructor: unknown } }).neonConfig.webSocketConstructor = WebSocket;

const DB_URL = process.env.NEON_DATABASE_URL || "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: DB_URL, max: 2, statement_timeout: 120_000 });

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params as never[])).rows as T[];
}

async function main() {
  // inserăm 60K rânduri temp pentru densitate reprezentativă
  console.log("Insert 60K temp rows…");
  const W1 = ["umbra", "codul", "visul", "noaptea", "cetatea", "nomadul", "vulpea", "coroana", "ultima", "primul", "secretul", "razboiul", "pasiunea", "clipa", "ecoul", "steaua", "insula", "padurea", "regina", "mercenarul"];
  const W2 = ["nordului", "verde", "de fier", "pierduta", "albastra", "ascunsa", "eterna", "de stanca", "din iarna", "lui vlad", "de sarare", "cu miere", "de marmura", "cu soare", "si umbra", "suspinul", "trofeul", "adevarului", "carpatin", "daciei"];
  for (let off = 0; off < 60_000; off += 3_000) {
    const vals: unknown[] = [];
    const rows: string[] = [];
    for (let j = 0; j < 3_000; j++) {
      const i = off + j;
      const title = `${W1[i % W1.length]} ${W2[Math.floor(i / W1.length) % W2.length]} ${Math.floor(i / (W1.length * W2.length))}`;
      const st = title.toLowerCase();
      const b = j * 9;
      vals.push(`diag:${i}`, title, title, "diag", "movie", "_scale_test", "url", null, st);
      rows.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
    }
    await q(`INSERT INTO content (external_id, title, original_title, description, content_type, provider, source_type, source_url, search_text) VALUES ${rows.join(",")}`, vals);
  }
  await q(`ANALYZE content`);
  console.log("60K inserate (~940/partiție)\n");

  // 1. EXPLAIN ANALYZE — separă Planning vs Execution
  const ex = await q<{ "QUERY PLAN": string }>(`
    EXPLAIN (ANALYZE, BUFFERS OFF, COSTS OFF, TIMING OFF, SUMMARY ON)
    SELECT id, title FROM content
    WHERE (search_text % 'umbra verde' OR search_text LIKE '%umbra verde%')
    ORDER BY similarity(search_text, 'umbra verde') * 3 DESC, popularity DESC, id DESC
    LIMIT 24`);
  const plan = ex.map((r) => r["QUERY PLAN"]);
  console.log("=== EXPLAIN ANALYZE (x64, 60K rânduri) ===");
  for (const line of plan) {
    if (/Planning Time|Execution Time|rows=|_parallel|Gather|Merge Append|Bitmap|Filter|actual time/.test(line)) console.log(" ", line.trim().slice(0, 140));
  }

  // 2. plan-cache:aceeași interogare de 10x (prepared implicit vs warm)
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await q(`SELECT id, title FROM content WHERE (search_text % $1 OR search_text LIKE $2) ORDER BY similarity(search_text, $1) * 3 DESC, popularity DESC, id DESC LIMIT 24`, ["codul de fier", "%codul de fier%"]);
    times.push(Date.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`\n10x aceeași interogare (extended protocol): P50=${times[5]}ms MIN=${times[0]} MAX=${times[9]}`);

  // 3. simplu count pe partiție (fără trigram) pentru baseline fan-out
  const t0 = Date.now();
  await q(`SELECT count(*) FROM content WHERE provider = '_scale_test'`);
  console.log(`count(*) full-fanout (seq pe 64 partiții): ${Date.now() - t0}ms`);

  // purge
  await q(`DELETE FROM content WHERE provider = '_scale_test'`);
  await q(`VACUUM content`);
  const r = await q<{ n: string; sz: string }>(`SELECT (SELECT count(*)::text FROM content) AS n, pg_size_pretty(pg_database_size(current_database()))::text AS sz`);
  console.log(`\nPurjat: content=${r[0].n} • DB ${r[0].sz}`);
  await pool.end();
}
main().catch((e) => { console.error("FAIL:", e.message); pool.end().finally(() => process.exit(1)); });
