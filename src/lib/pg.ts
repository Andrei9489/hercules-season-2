// Strat de date direct pe driverul Neon serverless (WebSocket, port 443)
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const globalForPg = globalThis as unknown as {
  __pgPool?: Pool;
  __pgBooted?: boolean;
};

function getPool(): Pool {
  if (!globalForPg.__pgPool) {
    const url =
      (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
        ? (process.env.NEON_DATABASE_URL as string)
        : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
    globalForPg.__pgPool = new Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 8_000, // conexiunile WS moarte sunt închise rapid
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
    msg.includes("Websocket")
  );
}

/** Execută o interogare parametrizată (cu retry la conexiuni moarte). */
export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  try {
    const res = await getPool().query(sql, params as never[]);
    return res.rows as T[];
  } catch (e) {
    if (isTransient(e)) {
      // aruncă pool-ul și reîncearcă o dată cu conexiune proaspătă
      try { await globalForPg.__pgPool?.end(); } catch { /* ignore */ }
      globalForPg.__pgPool = undefined;
      const res = await getPool().query(sql, params as never[]);
      return res.rows as T[];
    }
    throw e;
  }
}

/** Execută o interogare și întoarce primul rând sau null. */
export async function qOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}
