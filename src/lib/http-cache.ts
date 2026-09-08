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
