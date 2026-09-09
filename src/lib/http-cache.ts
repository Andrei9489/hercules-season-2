// ============================================================
// Faza 10 — HTTP cache edge/CDN-ready pentru API-urile de citire.
// Țintă: 10 mil. utilizatori simultan — cererile repetate ale
// utilizatorilor se servesc de la edge (Cache-Control s-maxage +
// stale-while-revalidate) FĂRĂ să mai atingă origin-ul, iar ETag
// economisește bandwidth (304 Not Modified).
// Aplicat pe: /api/browse, /api/channels, /api/status, /api/library (GET).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { recordRequest } from "@/lib/metrics";

type CacheOpts = {
  sMaxage: number;   // secunde în cache-ul edge/CDN (partajat)
  swr: number;       // stale-while-revalidate (servire expirată + revalidare în fundal)
  private?: boolean; // cache privat per-browser (nu CDN)
};

/**
 * Atașează headerele de cache + ETag pe un răspuns JSON și răspunde
 * 304 când If-None-Match se potrivește. NU cache-uim în browser mai
 * mult de max-age mic — validarea rămâne la origin/edge prin ETag.
 */
export function withCache<T>(
  req: NextRequest,
  payload: T,
  opts: CacheOpts,
  extraHeaders: Record<string, string> = {}
): NextResponse {
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;

  const inm = req.headers.get("if-none-match");
  const notModified = inm ? inm.split(",").map((s) => s.trim()).includes(etag) : false;

  const cacheControl = opts.private
    ? `private, max-age=${opts.sMaxage}, stale-while-revalidate=${opts.swr}`
    : `public, s-maxage=${opts.sMaxage}, stale-while-revalidate=${opts.swr}, max-age=0, must-revalidate`;

  const headers: Record<string, string> = {
    ...extraHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl,
    ETag: etag,
    Vary: "Accept-Encoding",
  };

  if (notModified) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(body, { status: 200, headers });
}

// ============================================================
// Faza 17 — Wrapper combinat pentru rutele publice GET:
//   1. MĂSURARE: durată + cod răspuns + stare cache → registru metrics
//      (vizibil în /api/metrics, format Prometheus).
//   2. EDGE CACHE: pe răspunsuri JSON 200 atașează Cache-Control
//      (s-maxage + stale-while-revalidate) + ETag, răspunde 304 pe
//      If-None-Match → CDN-ul servește repeat-urile FĂRĂ origin.
//   3. Erorile handler-ului sunt înregistrate (code 500) și re-arlancate.
//
// Aplicat pe cele 10 rute de cataloage externe (Faza 17a) — răspunsuri
// 100% publice (fără sesiune, fără personalizare) → cache CDN sigur.
// ============================================================

type PublicCacheOpts = {
  sMaxage: number;
  swr: number;
};

export function wrapPublicGet(
  route: string,
  handler: (req: NextRequest) => Promise<Response>,
  opts: PublicCacheOpts
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await handler(req);
    } catch (e) {
      recordRequest(route, 500, Date.now() - t0, "error");
      throw e;
    }

    const ms = Date.now() - t0;

    // Doar 200 JSON primește headere edge; restul trecute neatinse.
    const ctype = res.headers.get("content-type") || "";
    if (res.status === 200 && ctype.includes("application/json")) {
      const body = await res.text();
      const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
      const inm = req.headers.get("if-none-match");
      const notModified = inm
        ? inm.split(",").map((s) => s.trim()).includes(etag)
        : false;

      const headers: Record<string, string> = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, s-maxage=${opts.sMaxage}, stale-while-revalidate=${opts.swr}, max-age=0, must-revalidate`,
        ETag: etag,
        Vary: "Accept-Encoding",
      };
      // păstrează headere utile setate de handler (ex. rate limit)
      res.headers.forEach((v, k) => {
        if (k.toLowerCase().startsWith("x-ratelimit")) headers[k] = v;
      });

      if (notModified) {
        // 304 real: corpul nu pleacă deloc — bandwidth zero.
        recordRequest(route, 304, ms, "304");
        return new NextResponse(null, { status: 304, headers });
      }
      recordRequest(route, 200, ms, "origin");
      return new NextResponse(body, { status: 200, headers });
    }

    recordRequest(route, res.status, ms, res.status >= 500 ? "error" : "other");
    return res;
  };
}

/**
 * Faza 17 — wrapper DOAR metrics (fără cache) pentru rutele fierbinți care
 * își gestionează headerele de edge cache în interior (browse/search/library/
 * channels/status). Măsoară durata + codul final + starea cache dedusă din
 * răspuns (ETag 304 / headere CDN / altfel origin).
 */
export function wrapMetrics(
  route: string,
  handler: (req: NextRequest) => Promise<Response>
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await handler(req);
    } catch (e) {
      recordRequest(route, 500, Date.now() - t0, "error");
      throw e;
    }
    const ms = Date.now() - t0;
    const is304 = res.status === 304;
    const cc = res.headers.get("cache-control") || "";
    const cacheState = is304
      ? "304"
      : res.status >= 500
        ? "error"
        : cc.includes("s-maxage")
          ? "cdn-ready"
          : "origin";
    recordRequest(route, res.status, ms, cacheState);
    return res;
  };
}
