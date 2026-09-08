// Simple in-memory TTL cache for upstream API responses
import dns from "node:dns";

// Sandbox-ul are routing IPv6 defect către unele hosts — forțăm IPv4-first
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* noop */
}

type CacheEntry = { data: unknown; expires: number };

const store = new Map<string, CacheEntry>();
const MAX_ENTRIES = 3_000; // Faza 10: crescut (browse L1 + stale fallback)

export function cacheGet<T>(key: string): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    store.delete(key);
    return null;
  }
  return hit.data as T;
}

/**
 * Faza 10 — cacheGetStale: returnează intrarea chiar dacă e expirată
 * (stale-while-error). Folosită de browse ca fallback la overload/
 * DB lent: utilizatorul primește pagina veche în loc de eroare.
 */
export function cacheGetStale<T>(key: string): T | null {
  const hit = store.get(key);
  return hit ? (hit.data as T) : null;
}

export function cacheSet(key: string, data: unknown, ttlSeconds: number): void {
  if (store.size >= MAX_ENTRIES) {
    // evict oldest
    const oldestKey = store.keys().next().value;
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(key, { data, expires: Date.now() + ttlSeconds * 1000 });
}

export async function cachedFetch<T>(
  url: string,
  opts: {
    ttl?: number;
    headers?: Record<string, string>;
    cacheKey?: string;
    timeoutMs?: number;
    retries?: number;
  } = {}
): Promise<T> {
  const { ttl = 300, headers, cacheKey, timeoutMs = 8000, retries = 2 } = opts;
  const key = cacheKey || url;
  const cached = cacheGet<T>(key);
  if (cached) return cached;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Upstream ${res.status}`);
      const data = (await res.json()) as T;
      cacheSet(key, data, ttl);
      return data;
    } catch (e) {
      lastErr = e;
      const msg = String((e as { message?: string })?.message || e);
      // nu reîncerca pentru erori "definitive" ale upstream-ului (ex: 401/404)
      if (msg.includes("Upstream 40") || msg === "This operation was aborted") {
        if (msg.includes("Upstream 40")) throw e;
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
