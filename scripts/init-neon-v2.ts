// Inițializare Neon Schema v2 — motor de căutare + bibliotecă universală
// Rulează: bun scripts/init-neon-v2.ts
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import { readFileSync } from "fs";

neonConfig.webSocketConstructor = WebSocket;
const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url });
const client = await pool.connect();

/** Split pe ";" ignorând conținutul dollar-quoted ($$...$$). */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inDollar = false;
  let dollarTag = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inDollar && ch === "$") {
      const m = /^(\$[a-zA-Z_]*\$)/.exec(sql.slice(i));
      if (m) {
        inDollar = true;
        dollarTag = m[1];
        buf += m[1];
        i += m[1].length - 1;
        continue;
      }
    } else if (inDollar && ch === "$") {
      if (sql.startsWith(dollarTag, i)) {
        inDollar = false;
        buf += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (!inDollar && ch === ";") {
      const st = buf.trim();
      if (st && !st.startsWith("--")) out.push(st);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const last = buf.trim();
  if (last && !last.startsWith("--")) out.push(last);
  return out;
}

const script = readFileSync("/home/z/my-project/scripts/neon-v2.sql", "utf-8");
const statements = splitStatements(
  script.replace(/^--[^\n]*$/gm, "").replace(/^-{3,}$/gm, "")
);

let ok = 0, skip = 0, fail = 0;
for (const query of statements) {
  try {
    await client.query(query);
    ok++;
  } catch (e: unknown) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      skip++;
    } else {
      fail++;
      console.error("ERR:", query.slice(0, 90).replace(/\n/g, " "), "->", msg.slice(0, 140));
    }
  }
}
console.log(`Schema v2: ${ok} aplicate, ${skip} existente, ${fail} erori`);

// Verificare structură
const parts = await client.query(
  `SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
   JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname IN ('content','search_logs','playback_events')
   ORDER BY c.relname`
);
console.log("Partiții create:", parts.rows.map((r: { relname: string }) => r.relname).join(", "));

const idx = await client.query(
  `SELECT indexname FROM pg_indexes WHERE tablename LIKE 'content%' OR tablename LIKE 'search_%' OR tablename LIKE 'playback%' ORDER BY indexname`
);
console.log(`Indexuri: ${idx.rows.length}`);

const fx = await client.query(
  `SELECT proname FROM pg_proc WHERE proname IN ('upsert_search_stat','record_playback')`
);
console.log("Funcții:", fx.rows.map((r: { proname: string }) => r.proname).join(", "));

const metrics = await client.query(`SELECT key, value FROM platform_metrics ORDER BY key`);
console.log("Targets:", metrics.rows.map((r: { key: string; value: string }) => `${r.key}=${Number(r.value).toExponential()}`).join(" | "));

client.release();
await pool.end();
