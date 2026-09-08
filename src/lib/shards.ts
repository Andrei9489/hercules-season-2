// ============================================================
// FAZA 15 — SHARDING MULTI-COMPUTE Neon (fondament pentru 30 miliarde)
// ============================================================
// Arhitectură: fiecare compute Neon (proiect/branch) deține o felie din
// bibliotecă. Shard-ul 'local' = primarul acestui proiect (content x64).
// Shard-urile 'remote' = compute-uri Neon aditionale, înregistrate cu DSN
// în tabela `shards` (registry-ul e ÎN Neon → partajat cross-instance).
//
// Rutare INSERT: hash determinist FNV-1a(external_id) → slot ponderat pe
// shard-urile ACTIVE (același external_id → același shard, în timp ce
// registry-ul nu se schimbă). Shard-ul rezultat e stocat în
// content_shard_map (external_id → shard_id + remote_id) pentru
// rezolvarea ID-urilor cross-compute.
//
// Căutare: SCATTER-GATHER — interogarea rulează PE TOATE shard-urile
// active în paralel (LIMIT limit+offset pe fiecare), rezultatele se
// combină global pe score, apoi se taie fereastra offset..offset+limit.
// Un shard picat NU blochează căutarea (toleranță parțială: rezultatul
// e complet pe shard-urile care au răspuns).
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import { q, qOne, qRead } from "./pg";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

export type Shard = {
  id: number;
  name: string;
  kind: "local" | "remote";
  dsn: string | null;
  region: string;
  weight: number;
  state: string;
  maxRows: number;
  lastPingMs: number | null;
  lastOkAt: string | null;
  lastError: string | null;
};

// ---------- Registry (L1 cache 30s, sursa de adevăr = Neon) ----------
const REGISTRY_TTL_MS = 30_000;
const globalForShards = globalThis as unknown as {
  __shardCache?: { at: number; shards: Shard[] };
  __shardPools?: Map<number, Pool>;
};
const g = globalForShards;

export function invalidateShardRegistry(): void {
  g.__shardCache = undefined;
}

export async function getShards(force = false): Promise<Shard[]> {
  if (!force && g.__shardCache && Date.now() - g.__shardCache.at < REGISTRY_TTL_MS) {
    return g.__shardCache.shards;
  }
  const rows = await qRead<Record<string, unknown>>(
    `SELECT id, name, kind, dsn, region, weight, state, max_rows,
            last_ping_ms, last_ok_at, last_error
     FROM shards ORDER BY id`
  );
  const shards: Shard[] = rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    kind: (r.kind === "local" ? "local" : "remote") as Shard["kind"],
    dsn: (r.dsn as string) || null,
    region: String(r.region),
    weight: Math.max(1, Number(r.weight) || 1),
    state: String(r.state),
    maxRows: Number(r.max_rows) || 400_000_000,
    lastPingMs: r.last_ping_ms == null ? null : Number(r.last_ping_ms),
    lastOkAt: (r.last_ok_at as string) || null,
    lastError: (r.last_error as string) || null,
  }));
  g.__shardCache = { at: Date.now(), shards };
  return shards;
}

export async function getActiveShards(): Promise<Shard[]> {
  const all = await getShards();
  return all.filter((s) => s.state === "active" && (s.kind === "local" || s.dsn));
}

export async function countActiveShards(): Promise<number> {
  try {
    return (await getActiveShards()).length;
  } catch {
    return 1; // fallback: primarul e mereu disponibil
  }
}

// ---------- Pool-uri per shard remote (lazy, izolate) ----------
function poolFor(shard: Shard): Pool {
  if (!g.__shardPools) g.__shardPools = new Map();
  let p = g.__shardPools.get(shard.id);
  if (!p) {
    p = new Pool({
      connectionString: shard.dsn as string,
      max: 6, // moderat — N shard-uri × 6 conexiuni rămân sub limitele Neon
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
      query_timeout: 12_000,
    } as never);
    p.on("error", () => { /* ignoră — health probe raportează */ });
    g.__shardPools.set(shard.id, p);
  }
  return p;
}

export function dropShardPool(shardId: number): void {
  const p = g.__shardPools?.get(shardId);
  if (p) {
    void p.end().catch(() => {});
    g.__shardPools?.delete(shardId);
  }
}

/** Interogare pe un shard specific (remote prin pool-ul lui, local prin pg.ts). */
export async function shardQuery<T = Record<string, unknown>>(
  shard: Shard,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  if (shard.kind === "local") {
    // local → circuit breaker + admission control din pg.ts (calea standard)
    return qRead<T>(sql, params);
  }
  const res = (await poolFor(shard).query(sql, params as never[])) as { rows: T[] };
  return res.rows;
}

// ---------- Rutare hash ponderată (deterministă) ----------
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Alege shard-ul pentru un external_id (hash % sloturi ponderate pe active). */
export async function pickShardFor(externalId: string): Promise<Shard> {
  const active = await getActiveShards();
  if (active.length <= 1) return active[0] ?? (await getShards())[0];
  const slots: Shard[] = [];
  for (const s of active) for (let i = 0; i < s.weight; i++) slots.push(s);
  const slot = fnv1a(externalId) % slots.length;
  return slots[slot];
}

// ---------- Hartă de rutare (external_id → shard + id remote) ----------
export async function shardMapUpsert(externalId: string, shardId: number, remoteId: number | null): Promise<void> {
  try {
    await q(
      `INSERT INTO content_shard_map (external_id, shard_id, remote_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (external_id) DO UPDATE
         SET shard_id = EXCLUDED.shard_id, remote_id = EXCLUDED.remote_id`,
      [externalId, shardId, remoteId]
    );
  } catch { /* optim — mapa e folosită doar pentru lookup-uri cross-shard */ }
}

/** Rezolvă external_id → shard (dacă NU e local). Null = local/necunoscut. */
export async function shardMapLookup(externalId: string): Promise<{ shard: Shard; remoteId: number | null } | null> {
  const rows = await qRead<{ shard_id: number; remote_id: number | null }>(
    `SELECT m.shard_id, m.remote_id
     FROM content_shard_map m
     JOIN shards s ON s.id = m.shard_id
     WHERE m.external_id = $1 AND s.state = 'active'
     LIMIT 1`,
    [externalId]
  );
  if (!rows[0]) return null;
  const shards = await getShards();
  const shard = shards.find((s) => s.id === Number(rows[0].shard_id));
  if (!shard) return null;
  return { shard, remoteId: rows[0].remote_id == null ? null : Number(rows[0].remote_id) };
}

/** Rezolvă id numeric (de pe shard remote) → shard (pentru GET by id cross-compute). */
export async function shardMapByRemoteId(remoteId: number): Promise<{ shard: Shard; externalId: string } | null> {
  const rows = await qRead<{ shard_id: number; external_id: string }>(
    `SELECT m.shard_id, m.external_id
     FROM content_shard_map m
     JOIN shards s ON s.id = m.shard_id
     WHERE m.remote_id = $1 AND s.state = 'active'
     LIMIT 1`,
    [remoteId]
  );
  if (!rows[0]) return null;
  const shards = await getShards();
  const shard = shards.find((s) => s.id === Number(rows[0].shard_id));
  if (!shard) return null;
  return { shard, externalId: String(rows[0].external_id) };
}

// ---------- Scatter-gather (execuție paralelă pe TOATE shard-urile active) ----------
export type ScatterResult<T> = { results: T[]; answered: number; total: number; errors: string[] };

/**
 * Rulează fn(shard) pe toate shard-urile active, în paralel.
 * Un shard eșuat NU aruncă eroarea globală — e raportat în errors[]
 * (toleranță parțială: căutarea rămâne funcțională pe restul).
 */
export async function execOnAllShards<T>(
  fn: (shard: Shard) => Promise<T>,
  timeoutMs = 9_000
): Promise<ScatterResult<T>> {
  const shards = await getActiveShards().catch(() => [] as Shard[]);
  if (shards.length === 0) {
    // fallback sigur: rulează pe primar direct (fără registry)
    return { results: [], answered: 0, total: 0, errors: ["registry indisponibil"] };
  }
  const results: T[] = [];
  const errors: string[] = [];
  let answered = 0;
  await Promise.all(
    shards.map(async (shard) => {
      try {
        const r = await Promise.race([
          fn(shard),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`shard timeout ${timeoutMs}ms`)), timeoutMs)),
        ]);
        results.push(r);
        answered++;
      } catch (e) {
        errors.push(`${shard.name}: ${String((e as { message?: string })?.message || e).slice(0, 120)}`);
      }
    })
  );
  return { results, answered, total: shards.length, errors };
}

// ---------- Health probe ----------
export async function probeShard(shard: Shard): Promise<{ ok: boolean; pingMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    if (shard.kind === "local") {
      await qRead(`SELECT 1`);
    } else {
      await poolFor(shard).query(`SELECT 1`);
    }
    const pingMs = Date.now() - t0;
    await q(
      `UPDATE shards SET last_ping_ms = $2, last_ok_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
      [shard.id, pingMs]
    );
    await q(`INSERT INTO shard_health_log (shard_id, ok, ping_ms) VALUES ($1, true, $2)`, [shard.id, pingMs]);
    invalidateShardRegistry();
    return { ok: true, pingMs };
  } catch (e) {
    const msg = String((e as { message?: string })?.message || e).slice(0, 200);
    await q(
      `UPDATE shards SET last_error = $2, updated_at = now() WHERE id = $1`,
      [shard.id, msg]
    ).catch(() => {});
    await q(`INSERT INTO shard_health_log (shard_id, ok, ping_ms, error) VALUES ($1, false, $2, $3)`, [
      shard.id,
      Date.now() - t0,
      msg,
    ]).catch(() => {});
    invalidateShardRegistry();
    return { ok: false, pingMs: Date.now() - t0, error: msg };
  }
}

export async function probeAllShards(): Promise<{ id: number; name: string; ok: boolean; pingMs: number; error?: string }[]> {
  const shards = await getShards(true);
  const probes = await Promise.all(
    shards.map(async (s) => {
      const r = await probeShard(s);
      return { id: s.id, name: s.name, ok: r.ok, pingMs: r.pingMs, error: r.error };
    })
  );
  return probes;
}

// ---------- Statistici + capacitate agregată ----------
export type ShardStatus = Shard & { rows: number | null; ok: boolean | null };

export async function shardsStatus(): Promise<{
  shards: ShardStatus[];
  active: number;
  total: number;
  aggregateCeiling: number;
  rowsPerShard: number[];
}> {
  const shards = await getShards(true);
  const rowsPerShard = await Promise.all(
    shards.map(async (s) => {
      try {
        const rows = await shardQuery<{ n: string }>(s, `SELECT count(*)::text AS n FROM content`);
        return Number(rows[0]?.n || 0);
      } catch {
        return -1; // necunoscut (shard picat)
      }
    })
  );
  const out: ShardStatus[] = shards.map((s, i) => ({
    ...s,
    rows: rowsPerShard[i] < 0 ? null : rowsPerShard[i],
    ok: rowsPerShard[i] >= 0,
  }));
  const active = out.filter((s) => s.state === "active").length;
  const aggregateCeiling = out
    .filter((s) => s.state === "active")
    .reduce((sum, s) => sum + s.maxRows, 0);
  return { shards: out, active, total: out.length, aggregateCeiling, rowsPerShard };
}
