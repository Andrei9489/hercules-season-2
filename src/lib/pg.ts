// Strat de date direct pe driverul Neon serverless (WebSocket, port 443)
// Faza 3: retry robust fără cursă de distrugere a pool-ului (lock `replacing`),
// pool lărgit la 12, idle 15s (handshake WS ~100-300ms — nu reciclăm agresiv).
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const globalForPg = globalThis as unknown as {
  __pgPool?: Pool;
  __pgReplacing?: boolean;
};

function getPool(): Pool {
  if (!globalForPg.__pgPool) {
    const url =
      (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
        ? (process.env.NEON_DATABASE_URL as string)
        : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
    globalForPg.__pgPool = new Pool({
      connectionString: url,
      max: 12, // Faza 3: 12 conexiuni WS (handshake rapid, reutilizate)
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 10_000,
    });
    globalForPg.__pgPool.on("error", (err) => {
      console.error("Neon pool error (ignored):", err.message);
    });
  }
  return globalForPg.__pgPool;
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
async function replacePool(): Promise<void> {
  if (globalForPg.__pgReplacing) return;
  globalForPg.__pgReplacing = true;
  try {
    const old = globalForPg.__pgPool;
    globalForPg.__pgPool = undefined;
    try { await old?.end(); } catch { /* ignore */ }
  } finally {
    globalForPg.__pgReplacing = false;
  }
}

/** Execută o interogare parametrizată (cu retry la conexiuni moarte). */
export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await getPool().query(sql, params as never[]);
      return res.rows as T[];
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e;
      if (attempt < 3) {
        // a doua eșuare → pool-ul e suspect; înlocuim sub mutex și reîncercăm
        if (attempt >= 2) await replacePool();
        await new Promise((r) => setTimeout(r, 60 * attempt));
      }
    }
  }
  throw lastErr;
}

/** Execută o interogare și întoarce primul rând sau null. */
export async function qOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}
