// Strat de date direct pe driverul Neon serverless (WebSocket, port 443)
// Faza 3: retry robust fără cursă de distrugere a pool-ului (lock `replacing`),
// pool lărgit la 12, idle 15s (handshake WS ~100-300ms — nu reciclăm agresiv).
// Faza 6: router READ/WRITE — pool RW (scrieri) + pool RO separat (citiri);
// NEON_REPLICA_URL → replică de citire dedicată când va fi provisionată
// (Neon read-replica). Fără replică, pool-ul RO izolează totuși citirile
// de scrieri (conexiuni + handshake separat) — sub benchmark, contensia
// pe pool-ul partajat scade vizibil.
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const globalForPg = globalThis as unknown as {
  __pgPool?: Pool;
  __pgPoolRo?: Pool;
  __pgReplacing?: boolean;
  __pgReplacingRo?: boolean;
};

const DB_URL =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? (process.env.NEON_DATABASE_URL as string)
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

// URL-ul pentru citiri: replică dedicată dacă există, altfel primarul.
// (qRead rămâne corect oricum: pool separat = izolare de load-ul de scrieri)
const RO_URL =
  (process.env.NEON_REPLICA_URL || "").startsWith("postgres")
    ? (process.env.NEON_REPLICA_URL as string)
    : DB_URL;

function makePool(connectionString: string, max: number): Pool {
  const p = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 10_000,
  });
  p.on("error", (err) => {
    console.error("Neon pool error (ignored):", err.message);
  });
  return p;
}

function getPool(): Pool {
  if (!globalForPg.__pgPool) {
    globalForPg.__pgPool = makePool(DB_URL, 12); // scrieri + origin reads
  }
  return globalForPg.__pgPool;
}

function getPoolRo(): Pool {
  if (!globalForPg.__pgPoolRo) {
    // Faza 6: pool RO dedicat (replica-ready). max 10 → total conexiuni
    // pe compute Neon rămâne moderat, dar citirile nu mai concurează
    // cu scrierile la coada pe aceleași 12 conexiuni.
    globalForPg.__pgPoolRo = makePool(RO_URL, 10);
  }
  return globalForPg.__pgPoolRo;
}

export function replicaEnabled(): boolean {
  return (process.env.NEON_REPLICA_URL || "").startsWith("postgres");
}

function isTransient(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message || e);
  return (
    msg.includes("socket hang up") ||
    msg.includes("ECONNRESET") ||
    msg.includes("Connection terminated") ||
    msg.includes("timeout") ||
    msg.includes("Websocket") ||
    msg.includes("Cannot use a pool after calling end")
  );
}

/** Înlocuiește pool-ul o singură dată (mutex) — previne cursa multi-caller. */
async function replacePool(ro: boolean): Promise<void> {
  const flag = ro ? "__pgReplacingRo" : "__pgReplacing";
  if (globalForPg[flag]) return;
  globalForPg[flag] = true;
  try {
    if (ro) {
      const old = globalForPg.__pgPoolRo;
      globalForPg.__pgPoolRo = undefined;
      try { await old?.end(); } catch { /* ignore */ }
    } else {
      const old = globalForPg.__pgPool;
      globalForPg.__pgPool = undefined;
      try { await old?.end(); } catch { /* ignore */ }
    }
  } finally {
    globalForPg[flag] = false;
  }
}

async function run<T>(ro: boolean, sql: string, params: unknown[]): Promise<T[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const pool = ro ? getPoolRo() : getPool();
      const res = await pool.query(sql, params as never[]);
      return res.rows as T[];
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e;
      if (attempt < 3) {
        // a doua eșuare → pool-ul e suspect; înlocuim sub mutex și reîncercăm
        if (attempt >= 2) await replacePool(ro);
        await new Promise((r) => setTimeout(r, 60 * attempt));
      }
    }
  }
  throw lastErr;
}

/** Execută o interogare de SCRIERE (sau citire pe pool-ul principal). */
export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return run<T>(false, sql, params);
}

/**
 * Faza 6: citire pe pool-ul RO dedicat (replica-ready).
 * Folosit pe căile de citire mari: origin search, suggest, trending,
 * listări canale/radio, metrici. Scrierile rămân pe q().
 */
export async function qRead<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return run<T>(true, sql, params);
}

/** Execută o interogare și întoarce primul rând sau null. */
export async function qOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}
