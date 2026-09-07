// ============================================================
// Faza 7 — BOOTSTRAP AI: rulează job-urile AI pe biblioteca reală
//  1. Metadate TMDB (ro-RO) — bucle până acoperă biblioteca tmdb:%
//  2. Clasificare LLM canale TV/radio
//  3. Genuri & categorii AI (taxonomie completă + trilogii)
//  4. Analiză AI (snapshot live în Neon)
// Rulare: bun run scripts/ai-bootstrap.ts
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import { runMetadataJob, runGenresJob } from "../src/lib/ai-jobs";
import { runAnalyzer } from "../src/lib/ai-engine";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const ROUNDS = Number(process.env.AI_ROUNDS || 8);

async function main() {
  console.log(`=== BOOTSTRAP AI — ${ROUNDS} runde TMDB + LLM + genuri + analiză ===`);

  for (let i = 1; i <= ROUNDS; i++) {
    const t0 = Date.now();
    const r = await runMetadataJob(400, 0, 60);
    console.log(
      `[TMDB ${i}/${ROUNDS}] updatate=${r.tmdbUpdated} notFound=${r.tmdbNotFound} procesate=${r.processed} în ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    if ((r.tmdbUpdated as number) === 0 && (r.tmdbNotFound as number) === 0) {
      console.log("  → nu mai există ținte TMDB, opresc bucla");
      break;
    }
  }

  console.log("\n=== Clasificare LLM canale TV/radio ===");
  const t1 = Date.now();
  const llm = await runMetadataJob(20, 6, 60);
  console.log(
    `LLM: batch-uri=${llm.llmBatches} itemi=${llm.llmItems} legături=${llm.linksAdded} descrieri derivate=${llm.descDerived} în ${((Date.now() - t1) / 1000).toFixed(1)}s`
  );

  console.log("\n=== Genuri & categorii AI ===");
  const t2 = Date.now();
  const g = await runGenresJob();
  console.log(
    `Genuri: procesate=${g.processed} legături noi=${g.insertedLinks} trilogii=${g.trilogiesFound} în ${((Date.now() - t2) / 1000).toFixed(1)}s`
  );

  console.log("\n=== Analiză AI ===");
  const snap = await runAnalyzer(true);
  console.log(`Total: ${snap.total} | taxonomii: ${snap.totals.genresTotal} | cu genuri: ${snap.totals.withGenres} | fără genuri: ${snap.totals.withoutGenres}`);
  console.log(`Rezumat AI (${snap.summarySource}): ${snap.summary.slice(0, 220)}`);

  // stare finală taxonomie
  const pool = new Pool({
    connectionString:
      process.env.NEON_DATABASE_URL ||
      "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require",
    max: 2,
  });
  const byKind = await pool.query(`SELECT kind, count(*)::int AS n, sum(content_count)::int AS links FROM genres GROUP BY 1 ORDER BY 1`);
  console.log("\nTaxonomie finală pe tipuri:");
  for (const r of byKind.rows) console.log(`  ${r.kind}: ${r.n} intrări, ${r.links} legături`);
  const cov = await pool.query(
    `SELECT (SELECT count(*) FROM content)::int AS total,
            (SELECT count(DISTINCT content_id) FROM content_genres)::int AS with_genres`
  );
  console.log(`Acoperire genuri: ${cov.rows[0].with_genres}/${cov.rows[0].total}`);
  await pool.end();
}

main().catch((e) => {
  console.error("BOOTSTRAP EROARE:", e);
  process.exit(1);
});
