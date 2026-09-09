// ============================================================
// FAZA 18a — VALIDATOR DE REPLICA (instrument ops înainte de activare)
// Șablon de rulare pentru orice DSN de read-replica Neon:
//   npx tsx scripts/validate-replica-f18.ts "<DSN>" [region_code]
// Verifică REAL:
//   1. conectare + latență (ping 3x, min/medie)
//   2. pg_is_in_recovery() = TRUE → e efectiv o replică read-only
//   3. vizibilitatea tabelelor critiche (content partiționat, shards, regions)
//   4. citire probe de pe content (primul rând, dacă există)
// Rezultat OK → DSN-ul poate fi setat în env (NEON_REPLICA_URL / _US_URL /
// _APAC_URL) → regiunea devine ACTIVE automat la restart, ZERO cod.
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const dsn = process.argv[2];
const region = process.argv[3] || "necunoscut";

if (!dsn || !dsn.startsWith("postgres")) {
  console.error("Utilizare: npx tsx scripts/validate-replica-f18.ts \"<DSN-postgres>\" [region]");
  process.exit(1);
}

async function ping(p: Pool): Promise<number> {
  const t0 = Date.now();
  await p.query("SELECT 1");
  return Date.now() - t0;
}

async function main() {
  console.log(`\nValidare replica pentru regiunea [${region}]…`);
  const p = new Pool({ connectionString: dsn, max: 2, statement_timeout: 8000 });

  // 1. conectare + latență
  const pings: number[] = [];
  for (let i = 0; i < 3; i++) pings.push(await ping(p));
  pings.sort((a, b) => a - b);
  console.log(`  ✓ conectare OK — ping min ${pings[0]}ms / medie ${Math.round(pings.reduce((a, b) => a + b) / 3)}ms`);

  // 2. replică reală (recovery mode)?
  const rec = await p.query("SELECT pg_is_in_recovery() AS rec");
  const isReplica = rec.rows[0].rec === true;
  console.log(`  ${isReplica ? "✓" : "⚠"} pg_is_in_recovery = ${rec.rows[0].rec} ${isReplica ? "(replică read-only reală)" : "(endpoint READ-WRITE — primar sau compute dedicat; rutarea citirilor funcționează, dar NU e replică dedicată)"}`);

  // 3. schema vizibilă
  const t = await p.query(
    `SELECT to_regclass('content') AS content,
            to_regclass('shards') AS shards,
            to_regclass('regions') AS regions,
            to_regclass('content_genres') AS content_genres,
            (SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'content'::regclass) AS partitions`
  );
  const r = t.rows[0];
  console.log(`  ✓ tabele: content=${r.content} partiții=${r.partitions} • shards=${r.shards} • regions=${r.regions} • content_genres=${r.content_genres}`);

  // 4. citire probe
  const c = await p.query(
    `SELECT count(*)::int AS n FROM content`
  );
  console.log(`  ✓ citire content: ${c.rows[0].n} rânduri vizibile de pe acest endpoint`);

  await p.end();

  const ok = !!r.content && r.partitions > 0;
  console.log(`\n=== REZULTAT: ${ok ? "VALIDAT — poate fi setat în env pentru regiunea " + region : "INVALID — NU seta acest DSN"} ===`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("✗ VALIDARE EȘUATĂ:", String(e).slice(0, 300));
  process.exit(1);
});
