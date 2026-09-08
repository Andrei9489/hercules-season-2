// Strat de date direct pe driverul Neon serverless (WebSocket, port 443)
// Faza 3: retry robust fără cursă de distrugere a pool-ului (lock `replacing`),
// pool lărgit la 12, idle 15s (handshake WS ~100-300ms — nu reciclăm agresiv).
// Faza 6: router READ/WRITE — pool RW (scrieri) + pool RO separat (citiri);
// NEON_REPLICA_URL → replică de citire dedicată când va fi provisionată
// (Neon read-replica). Fără replică, pool-ul RO izolează totuși citirile
// de scrieri (conexiuni + handshake separat) — sub benchmark, contensia
// pe pool-ul partajat scade vizibil.
// Faza 9: RESILIENȚĂ — circuit breaker (fail-fast când DB e picat),
// admission control pe citirile RO (plafon concurență + coadă) și
// statement_timeout per pool (nicio interogare nu poate bloca instanța).
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import {
  dbAllow,
  dbReportSuccess,
  dbReportFailure,
  withAdmission,
  AdmissionRejected,
} from "./circuit-breaker";

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

function makePool(connectionString: string, max: number, statementTimeoutMs: number): Pool {
  const p = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 10_000,
    // Faza 9: nicio interogare nu poate bloca o conexiune la nesfârșit —
    // citirile 8s (origin search/suggest), scrierile 20s (bulk M3U/AI jobs).
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + 2_000,
  } as never);
  p.on("error", (err) => {
    console.error("Neon pool error (ignored):", err.message);
  });
  return p;
}

function getPool(): Pool {
  if (!globalForPg.__pgPool) {
    globalForPg.__pgPool = makePool(DB_URL, 12, 20_000); // scrieri + origin reads
  }
  return globalForPg.__pgPool;
}

function getPoolRo(): Pool {
  if (!globalForPg.__pgPoolRo) {
    // Faza 6: pool RO dedicat (replica-ready). max 10 → total conexiuni
    // pe compute Neon rămâne moderat, dar citirile nu mai concurează
    // cu scrierile la coada pe aceleași 12 conexiuni.
    globalForPg.__pgPoolRo = makePool(RO_URL, 10, 8_000);
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
    msg.includes("Cannot use a pool after calling end") ||
    msg.includes("statement timeout") ||
    msg.includes("canceling statement due to statement timeout")
  );
}

/** Eroare dedicată: circuit deschis sau admission full — apelantul servește degradat. */
export class DbUnavailable extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DbUnavailable";
  }
}

export { AdmissionRejected };

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
  // Faza 9: circuit breaker — când DB e jos, eșuăm INSTANT (fail-fast)
  // pentru ca straturile de deasupra să servească din cache (mod degradat).
  const permit = dbAllow();
  if (!permit.allowed) {
    throw new DbUnavailable(`circuit ${permit.state} — DB temporar indisponibil`);
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const pool = ro ? getPoolRo() : getPool();
      const exec = () => pool.query(sql, params as never[]) as Promise<{ rows: T[] }>;
      // Faza 9: admission control DOAR pe citirile RO (origin search/suggest/
      // trending/listări) — scrierile trec necondiționat (import M3U, play events).
      const res = ro ? await withAdmission(exec) : await exec();
      dbReportSuccess();
      return res.rows as T[];
    } catch (e) {
      lastErr = e;
      // AdmissionRejected nu e o eroare DB — nu recalculăm pool-ul, doar încercăm
      // din nou (coada s-ar fi mișcat) până se consumă retry-urile.
      if (e instanceof AdmissionRejected) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 80 * attempt));
          continue;
        }
        throw e;
      }
      if (!isTransient(e)) {
        // eroare de logică/SQL (nu de conexiune) — NU trip-uiește breaker-ul
        throw e;
      }
      // eroare tranzientă de conexiune/overload → semnalăm breaker-ului
      dbReportFailure();
      if (attempt < 3) {
        // a doua eșuare → pool-ul e suspect; înlocuim sub mutex și reîncercăm
        if (attempt >= 2) await replacePool(ro);
        await new Promise((r) => setTimeout(r, 60 * attempt));
      }
    }
  }
  // toate reîncercările au eșuat cu erori tranziente → breaker
  dbReportFailure();
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

/**
 * Faza 13: împrumută UN client dedicat din pool-ul RW pentru durata unui
 * bloc de operații pe aceeași sesiune (ex. pg_try_advisory_lock/unlock —
 * lock-ul de sesiune e valabil doar pe conexiunea care l-a luat).
 * Clientul e returnat pool-ului în finally, indiferent de rezultat.
 */
export async function withRwClient<T>(
  fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client as unknown as Parameters<typeof fn>[0]);
  } finally {
    try {
      client.release();
    } catch {
      /* client deja eliberat */
    }
  }
}
