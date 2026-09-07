// Marchează 4 itemii 404 ca extrase (evită bucla infinită) + taxonomie + analiză
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import { q } from "../src/lib/pg";
import { runGenresJob } from "../src/lib/ai-jobs";
import { runAnalyzer } from "../src/lib/ai-engine";
neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

// itemii tmdb rămâne fără marker = 404 la TMDB → marchează ca încercate
const r = await q<Record<string, unknown>>(
  `UPDATE content SET meta = jsonb_set(COALESCE(meta,'{}'::jsonb), '{aiExtractedAt}', to_jsonb(now()::text), true)
   WHERE external_id LIKE 'tmdb:%' AND NOT meta ? 'aiExtractedAt' RETURNING id`
);
console.log("marcate ca încercate (404 TMDB):", r.length);

const g = await runGenresJob();
console.log(`taxonomie regenerată: +${g.insertedLinks} legături noi, ${g.trilogiesFound} trilogii`);

const snap = await runAnalyzer(true);
console.log(`ANALIZĂ: ${snap.summary}`);
console.log(`acoperire: cuGenuri=${snap.totals.withGenres}/${snap.total} cuAn=${snap.totals.withYear} cuDesc=${snap.totals.withDescription} extrase=${snap.totals.aiExtracted}`);

const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL || "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require", max: 2 });
const c = await pool.query(`SELECT
  (SELECT count(*) FROM genres)::int AS taxonomii,
  (SELECT count(*) FROM content_genres)::int AS legaturi,
  (SELECT count(*) FROM genres WHERE kind='genre' AND content_count>0)::int AS genuri_active,
  (SELECT count(*) FROM genres WHERE kind='studio' AND content_count>0)::int AS studiouri,
  (SELECT count(*) FROM genres WHERE kind='franchise' AND content_count>0)::int AS francize,
  (SELECT count(*) FROM genres WHERE kind='collection' AND content_count>0)::int AS colectii,
  (SELECT count(*) FROM genres WHERE kind='trilogy')::int AS trilogii`);
console.log("TAXONOMIE FINALĂ:", c.rows[0]);
await pool.end();
console.log("GATA");
