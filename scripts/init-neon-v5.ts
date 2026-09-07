// Faza 6 — aplică DDL v5 (rollup sugestii) + refresh inițial bucket-e 1-3
import { readFileSync } from "node:fs";
import path from "node:path";
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL!
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: url, max: 6 });

async function main() {
  const ddl = readFileSync(path.join(import.meta.dir, "neon-v5.sql"), "utf8");

  // statementele obișnuite se split-uiesc pe `;`, DAR funcția plpgsql
  // (dintre CREATE OR REPLACE FUNCTION ... $$;) se execută INTEGRALĂ,
  // pentru că corpul $$...$$ conține `;` interne.
  const fnMatch = ddl.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;\s*$/m);
  const fnSql = fnMatch ? fnMatch[0] : "";
  const rest = fnSql
    ? ddl.replace(fnSql, "")
    : ddl;

  // elimină liniile de comentarii `--` (pot conține `;` care ar rupe split-ul)
  const restClean = rest
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const stmts: string[] = [];
  for (const s of restClean.split(";")) {
    const t = s.trim();
    if (t.length > 1) stmts.push(t);
  }
  if (fnSql.trim()) stmts.push(fnSql.trim());

  let ok = 0;
  for (const s of stmts) {
    try {
      await pool.query(s);
      ok++;
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes("already exists")) {
        console.log(`  (există deja) ${s.slice(0, 60)}…`);
        ok++;
      } else {
        console.error(`  EROARE la: ${s.slice(0, 80)}… → ${msg}`);
        throw e;
      }
    }
  }
  console.log(`DDL v5: ${ok}/${stmts.length} instrucțiuni OK`);

  // refresh inițial: lungimi 1, 2, 3
  for (const len of [1, 2, 3]) {
    const t0 = Date.now();
    const r = await pool.query(`SELECT refresh_suggest_rollup($1) AS n`, [len]);
    console.log(
      `rollup len=${len}: ${r.rows[0].n} bucket-e în ${Date.now() - t0}ms`
    );
  }

  const total = await pool.query(`SELECT count(*)::int AS n FROM suggest_rollup`);
  console.log(`Total bucket-e rollup: ${total.rows[0].n}`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
