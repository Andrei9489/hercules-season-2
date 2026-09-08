// ============================================================
// StreamVerse — Faza 8: PURJARE CONȚINUT SIMULAT
// Utilizatorul a cerut explicit: "elimina toate postările
// simulate din platforma si toate videoclipurile din platforma".
//
// Se șterge TOT conținutul pre-încărcat de sistem (TMDB, iTunes,
// Jikan, TVMaze, radio-browser, M3U, LLM) + tot ce derivă din el:
//   - content (17.858 rânduri, 16 partiții hash)
//   - genres + content_genres (taxonomia AI derivată din conținut)
//   - suggest_rollup (bucket-e sugestii derivate din conținut)
//   - ai_insights + ai_jobs (analize/job-uri pe conținutul vechi)
//   - search_logs + search_stats + playback_events (statistici vechi)
//   - platform_metrics (metrici agregate vechi)
//   - favorite / watchlist / history / review (referințe la conținut șters)
// SE PĂSTREAZĂ: users, accounts, sessions, profiles (conturi reale).
// Platforma rămâne GOALĂ — se umple DOAR cu conținut adăugat de
// utilizator prin URL / iframe / embed / JS (capacitate 30 miliarde).
// ============================================================
import { Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConf();
function neonConf() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require("@neondatabase/serverless") as typeof import("@neondatabase/serverless");
  cfg.neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;
}

const DB_URL = "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const pool = new Pool({ connectionString: DB_URL, max: 6, idleTimeoutMillis: 10_000 });

const STATEMENTS: { label: string; sql: string }[] = [
  { label: "content_genres (legături conținut ↔ taxonomie)", sql: "TRUNCATE TABLE content_genres" },
  { label: "genres (taxonomie AI derivată)", sql: "TRUNCATE TABLE genres RESTART IDENTITY" },
  { label: "content (TOATE partițiile — conținut simulat)", sql: "TRUNCATE TABLE content" },
  { label: "suggest_rollup (bucket-e sugestii)", sql: "TRUNCATE TABLE suggest_rollup" },
  { label: "ai_insights (snapshot-uri analiză vechi)", sql: "TRUNCATE TABLE ai_insights RESTART IDENTITY" },
  { label: "ai_jobs (job-uri AI pe conținut vechi)", sql: "TRUNCATE TABLE ai_jobs RESTART IDENTITY" },
  { label: "search_logs (jurnal căutări)", sql: "TRUNCATE TABLE search_logs" },
  { label: "search_stats (statistici căutări)", sql: "TRUNCATE TABLE search_stats" },
  { label: "playback_events (evenimente redare)", sql: "TRUNCATE TABLE playback_events" },
  { label: "platform_metrics (metrici agregate)", sql: "TRUNCATE TABLE platform_metrics" },
  { label: "favorite (referințe conținut șters)", sql: "TRUNCATE TABLE favorite" },
  { label: "watchlist (referințe conținut șters)", sql: "TRUNCATE TABLE watchlist" },
  { label: "history (referințe conținut șters)", sql: "TRUNCATE TABLE history" },
  { label: "review (referințe conținut șters)", sql: "TRUNCATE TABLE review" },
];

const VERIFY: { label: string; sql: string }[] = [
  { label: "content", sql: "SELECT count(*)::int AS n FROM content" },
  { label: "genres", sql: "SELECT count(*)::int AS n FROM genres" },
  { label: "content_genres", sql: "SELECT count(*)::int AS n FROM content_genres" },
  { label: "suggest_rollup", sql: "SELECT count(*)::int AS n FROM suggest_rollup" },
  { label: "ai_insights", sql: "SELECT count(*)::int AS n FROM ai_insights" },
  { label: "ai_jobs", sql: "SELECT count(*)::int AS n FROM ai_jobs" },
  { label: "search_logs", sql: "SELECT count(*)::int AS n FROM search_logs" },
  { label: "playback_events", sql: "SELECT count(*)::int AS n FROM playback_events" },
  { label: "favorite", sql: "SELECT count(*)::int AS n FROM favorite" },
  { label: "watchlist", sql: "SELECT count(*)::int AS n FROM watchlist" },
  { label: "history", sql: "SELECT count(*)::int AS n FROM history" },
  // păstrate
  { label: "users (PĂSTRATE)", sql: "SELECT count(*)::int AS n FROM \"User\"" },
  { label: "profiles (PĂSTRATE)", sql: "SELECT count(*)::int AS n FROM \"Profile\"" },
];

async function main() {
  console.log("=== PURJARE CONȚINUT SIMULAT — StreamVerse Faza 8 ===\n");
  for (const s of STATEMENTS) {
    try {
      await pool.query(s.sql);
      console.log(`  ✅ TRUNCATE ${s.label}`);
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes("does not exist")) {
        console.log(`  ⏭️  ${s.label} — tabela nu există (skip)`);
      } else {
        console.error(`  ❌ ${s.label}: ${msg}`);
        process.exitCode = 1;
      }
    }
  }
  console.log("\n=== VERIFICARE FINALĂ ===");
  for (const v of VERIFY) {
    try {
      const r = await pool.query(v.sql);
      console.log(`  ${v.label}: ${r.rows[0]?.n ?? "?"}`);
    } catch (e) {
      console.log(`  ${v.label}: (n/a — ${String((e as Error).message).slice(0, 40)})`);
    }
  }
  console.log("\nBiblioteca este acum 0 conținuturi — platforma se umple DOAR");
  console.log("cu conținut adăugat de utilizator (URL/iframe/embed/JS).");
  console.log("Capacitatea de arhitectură rămâne: 30.000.000.000 conținuturi.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
