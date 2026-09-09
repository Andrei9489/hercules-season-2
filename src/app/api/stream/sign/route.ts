// ============================================================
// Faza 10 — POST /api/stream/sign — semnare server-side URL stream.
// Playerul cere semnătura la redare; secretul rămâne în Neon
// (content.meta.signing) și NU ajunge niciodată în browser.
// Body: { contentId: number } → { ok, signedUrl, expiresInSec, kind }
// Rate limit: 90/min anonim, 240/min autentificat (token bucket).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { qRead } from "@/lib/pg";
import { parseSigningConfig, applySigning } from "@/lib/stream-sign";
import { rateLimitTiered, clientIp, tooMany } from "@/lib/rate-limit";

const SIGNABLE = new Set(["video", "hls", "dash", "ts"]);

export async function POST(req: NextRequest) {
  // nivel de acces: autentificat (cookie sesiune) → buget 2.5x (Faza 10)
  const rl = rateLimitTiered(
    req,
    `sign:${clientIp(req)}`,
    { burst: 12, perMinute: 90 },
    { burst: 30, perMinute: 240 }
  );
  if (!rl.ok) return tooMany(rl);

  let body: { contentId?: unknown };
  try {
    body = (await req.json()) as { contentId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad-json" }, { status: 400 });
  }
  const contentId = Number(body.contentId);
  if (!Number.isFinite(contentId) || contentId <= 0) {
    return NextResponse.json({ ok: false, error: "contentId invalid" }, { status: 400 });
  }

  const rows = await qRead<{
    source_url: string | null;
    source_type: string;
    signing: unknown;
  }>(
    `SELECT source_url, source_type, meta->'signing' AS signing
     FROM content WHERE id = $1 LIMIT 1`,
    [contentId]
  );
  const row = rows[0];
  if (!row) return NextResponse.json({ ok: false, error: "Conținut inexistent" }, { status: 404 });
  if (!row.source_url || !SIGNABLE.has(row.source_type)) {
    return NextResponse.json(
      { ok: false, error: "Semnarea se aplică doar pe streamuri directe (video/HLS/DASH/MPEG-TS)" },
      { status: 400 }
    );
  }
  const cfg = parseSigningConfig(row.signing);
  if (!cfg) return NextResponse.json({ ok: false, error: "Fără configurație de semnare validă" }, { status: 400 });

  try {
    const signed = applySigning(row.source_url, cfg);
    return NextResponse.json({
      ok: true,
      signedUrl: signed.url,
      expiresInSec: Math.max(5, Math.floor((signed.expiresAt - Date.now()) / 1000)),
      kind: row.source_type,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "URL sursă invalid pentru semnare" }, { status: 400 });
  }
}
