// FAZA 15 — Inițializează un SHARD Neon REAL: database nou pe proiectul Neon
// (compute dedicat la producție: proiect/branch separat — același DDL) cu
// schema `content` completă: partiții HASH x64 + toate indexurile motorului.
// Idempotent: SIGUR de re-rulat.
// Usage: bun scripts/init-shard-v15.ts [nume_db]   (implicit shard_b)
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const DB_NAME = process.argv[2] || "shard_b";
const shardUrl = new URL(url as string);
shardUrl.pathname = `/${DB_NAME}`;

const primary = new Pool({ connectionString: url, max: 1 });
const shard = new Pool({ connectionString: shardUrl.toString(), max: 2 });

async function main() {
  // 1) creează database-ul (idempotent)
  try {
    await primary.query(`CREATE DATABASE ${DB_NAME}`);
    console.log(`✅ CREATE DATABASE ${DB_NAME}`);
  } catch (e) {
    const msg = String((e as { message?: string })?.message || e);
    if (msg.includes("already exists")) console.log(`ℹ️  Database ${DB_NAME} există deja`);
    else throw e;
  }

  // 2) extensie trigram pe shard
  await shard.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  console.log("✅ pg_trgm activ pe shard");

  // 3) tabela content PARTITION BY HASH(id) + 64 partiții (identic cu primarul)
  await shard.query(`
    CREATE TABLE IF NOT EXISTS content (
      id BIGSERIAL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      original_title TEXT,
      description TEXT DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'video',
      brand TEXT,
      category TEXT,
      continent TEXT,
      country TEXT,
      language TEXT DEFAULT 'en',
      provider TEXT NOT NULL DEFAULT 'unknown',
      source_type TEXT NOT NULL DEFAULT 'url',
      source_url TEXT,
      embed_code TEXT,
      thumbnail TEXT,
      backdrop TEXT,
      duration_seconds INTEGER,
      year INTEGER,
      rating REAL DEFAULT 0,
      popularity BIGINT DEFAULT 0,
      views BIGINT DEFAULT 0,
      tags TEXT[] DEFAULT '{}',
      meta JSONB DEFAULT '{}',
      search_text TEXT NOT NULL DEFAULT '',
      search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (id)
    ) PARTITION BY HASH (id)
  `);
  let parts = 0;
  for (let i = 0; i < 64; i++) {
    const nn = String(i).padStart(2, "0");
    await shard.query(
      `CREATE TABLE IF NOT EXISTS content_h64_p${nn} PARTITION OF content FOR VALUES WITH (MODULUS 64, REMAINDER ${i})`
    );
    parts++;
  }
  console.log(`✅ content partiționat HASH x64 (${parts} partiții) pe shard`);

  // 4) indexurile motorului de căutare (identice cu primarul — Faza 2/4/6)
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_content_tsv ON content USING GIN (search_tsv)`,
    `CREATE INDEX IF NOT EXISTS idx_content_trgm_title ON content USING GIN (title gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_content_trgm_stext ON content USING GIN (search_text gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_content_stext_prefix ON content (search_text text_pattern_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_content_suggest ON content (search_text text_pattern_ops) INCLUDE (title, popularity)`,
    `CREATE INDEX IF NOT EXISTS idx_content_external ON content (external_id)`,
    `CREATE INDEX IF NOT EXISTS idx_content_type ON content (content_type)`,
    `CREATE INDEX IF NOT EXISTS idx_content_brand ON content (brand)`,
    `CREATE INDEX IF NOT EXISTS idx_content_provider ON content (provider)`,
    `CREATE INDEX IF NOT EXISTS idx_content_pop ON content (popularity DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_content_created ON content (created_at DESC)`,
  ];
  for (const [i, ix] of indexes.entries()) {
    await shard.query(ix);
    if ((i + 1) % 4 === 0) console.log(`  indexuri ${i + 1}/${indexes.length}…`);
  }
  console.log(`✅ ${indexes.length} indexuri create pe shard`);

  // 5) verificare structură
  const partsCount = await shard.query(`SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'content'::regclass`);
  const idxCount = await shard.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename LIKE 'content%'`);
  console.log(`📊 Shard ${DB_NAME}: ${partsCount.rows[0].n} partiții • ${idxCount.rows[0].n} indexuri content`);

  const masked = shardUrl.toString().replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
  console.log(`\n🔗 DSN shard (pentru înregistrare în registry):`);
  console.log(`   ${masked}`);
  console.log(`\nÎnregistrare: POST /api/shards {"op":"add","name":"${DB_NAME}-eu-central-1","dsn":"<DSN>"} + header x-shard-token`);
  console.log("✅ Shard inițializat complet.");
}

main()
  .then(async () => { await primary.end(); await shard.end(); })
  .catch(async (e) => {
    console.error("EȘEC init-shard:", e.message);
    process.exitCode = 1;
    await primary.end().catch(() => {});
    await shard.end().catch(() => {});
  });
