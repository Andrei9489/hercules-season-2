// ============================================================
// Rate limiting în memorie (token bucket per IP) — stratul 1 de
// protecție Neon la abuz, pe drumul spre 10.000 căutări simultane
// și 10 mil. utilizatori. Stateless per instanță → scale orizontal;
// sincronizare cross-node (L2 partajat) în Faza 4.
// ============================================================

type Bucket = { tokens: number; last: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000; // plafon memorie pentru IP-uri active

export type RateResult = { ok: boolean; remaining: number; retryAfterSec: number };

/**
 * Token bucket: capacitate `burst`, refil `perMinute` tokeni/minut
 * (proporțional cu timpul scurs, fără cron). Zero dependențe externe.
 */
export function rateLimit(
  key: string,
  opts: { burst?: number; perMinute?: number } = {}
): RateResult {
  const burst = opts.burst ?? 60;
  const perMinute = opts.perMinute ?? 120;
  const now = Date.now();
  const refillRate = perMinute / 60_000; // tokeni / ms

  // curățare anti-flood de memorie (IP-uri inactive > 2 min)
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (now - b.last > 120_000) buckets.delete(k);
      if (buckets.size <= MAX_BUCKETS * 0.8) break;
    }
  }

  const b = buckets.get(key) || { tokens: burst, last: now };
  const elapsed = Math.max(0, now - b.last);
  b.tokens = Math.min(burst, b.tokens + elapsed * refillRate);
  b.last = now;

  if (b.tokens < 1) {
    const retryAfterSec = Math.ceil(((1 - b.tokens) / refillRate) / 1000);
    buckets.set(key, b);
    return { ok: false, remaining: 0, retryAfterSec: Math.min(retryAfterSec, 120) };
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return { ok: true, remaining: Math.floor(b.tokens) };
}

/** IP-ul clientului din headerele gateway-ului (compat proxy). */
export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "anon"
  );
}

/**
 * Faza 10 — token bucket pe NIVELURI: utilizatorii autentificați
 * (cookie de sesiune next-auth prezent, fără hit DB) primesc buget
 * mai mare decât anonimii. Protecție corectă: abuzatorii anonimi
 * sunt limitați agresiv, utilizatorii reali nu simt limita.
 */
export function rateLimitTiered(
  req: Request,
  key: string,
  anon: { burst?: number; perMinute?: number },
  authed: { burst?: number; perMinute?: number }
): RateResult {
  const hasSession = Boolean(
    (req as Request & { cookies?: { get: (n: string) => { value: string } | undefined } }).cookies
      ?.get?.("next-auth.session-token") ||
      (req as Request & { cookies?: { get: (n: string) => { value: string } | undefined } }).cookies
        ?.get?.("__Secure-next-auth.session-token")
  );
  // NextRequest are .cookies; Request-urile obișnuite → fallback pe header
  const authedHeader = req.headers.get("cookie")?.includes("authjs.session-token") ||
    req.headers.get("cookie")?.includes("next-auth.session-token") ||
    req.headers.get("cookie")?.includes("__Secure-next-auth.session-token");
  return rateLimit(key, hasSession || authedHeader ? authed : anon);
}

/** Răspuns JSON standard pentru 429 + header Retry-After. */
export function tooMany(r: RateResult): Response {
  return new Response(
    JSON.stringify({ ok: false, error: "Prea multe cereri. Încetiniți puțin." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(r.retryAfterSec),
        "X-RateLimit-Remaining": "0",
      },
    }
  );
}
