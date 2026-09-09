// FAZA 16b — SHARD-HELP: VACUUM FULL pe toate partițiile content (+ harta de
// rutare pe primar) pentru a RECĂȘTIGA fizic spațiul consumat de valurile
// de ingest (DELETE + VACUUM simplu NU micșorează fișierele; 512 MB limită
// proiect Neon). Rulează când nu există trafic pe tabele (lock exclusiv).
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const URL =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const dbs: { name: string; dsn: string }[] = [
  { name: "primar (neondb)", dsn: URL },
];

async function sizeOf(pool: Pool): Promise<number> {
  const r = await pool.query(`SELECT pg_database_size(current_database())::bigint AS sz`);
  return Number((r.rows[0] as { sz: string }).sz);
}

async function shrink(pool: Pool, label: string) {
  const before = await sizeOf(pool);
  console.log(`\n[${label}] înainte: ${(before / 1024 / 1024).toFixed(1)} MB`);

  // 1) enumeră partițiile content
  const parts = await pool.query(
    `SELECT c.relname FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'content'::regclass ORDER BY c.relname`
  );
  const names = (parts.rows as { relname: string }[]).map((r) => r.relname);
  console.log(`[${label}] VACUUM FULL pe ${names.length} partiții content...`);
  for (const [i, n] of names.entries()) {
    await pool.query(`VACUUM FULL ANALYZE "${n}"`);
    if ((i + 1) % 16 === 0) console.log(`  ${i + 1}/${names.length}...`);
  }

  // 2) tabele ajutătoare cu bloat posibil (pe primar: harta de rutare)
  try { await pool.query(`VACUUM FULL ANALYZE content_shard_map`); } catch { /* nu există pe shard */ }

  const after = await sizeOf(pool);
  console.log(`[${label}] după: ${(after / 1024 / 1024).toFixed(1)} MB (recâștigat ${((before - after) / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  // primar
  const admin = new Pool({ connectionString: URL, max: 1, statement_timeout: 300_000 } as never);
  await shrink(admin, dbs[0].name);

  // shard_b (dacă are schema content)
  const reg = await admin.query(`SELECT name, dsn, state FROM shards WHERE kind = 'remote' AND dsn IS NOT NULL`);
  for (const row of reg.rows as { name: string; dsn: string; state: string }[]) {
    console.log(`\n→ shard remote: ${row.name} (${row.state})`);
    const p = new Pool({ connectionString: row.dsn, max: 1, statement_timeout: 300_000 } as never);
    try {
      const has = await p.query(`SELECT to_regclass('content') IS NOT NULL AS ok`);
      if ((has.rows[0] as { ok: boolean }).ok) await shrink(p, row.name);
      else console.log(`  fără tabela content — sare`);
    } catch (e) {
      console.error(`  eroare: ${String((e as { message?: string })?.message || e).slice(0, 120)}`);
    } finally {
      await p.end().catch(() => {});
    }
  }

  await admin.end();
  console.log("\n✅ Shrink complet.");
  process.exit(0);
}

main().catch((e) => { console.error("EȘEC SHRINK:", e); process.exit(1); });
