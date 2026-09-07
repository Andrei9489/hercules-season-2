// Faza 7 — EXTRAGERE METADATE AI
// GET  → statistici metadate lipsă + istoric job-uri
// POST → rulează job-ul AI: detalii TMDB (ro-RO) + clasificare LLM
//        canale TV/radio + descrieri derivate reale → salvate în Neon
import { NextRequest, NextResponse } from "next/server";
import { getMetadataStats } from "@/lib/ai-engine";
import { runMetadataJob } from "@/lib/ai-jobs";
import { clientIp, rateLimit, tooMany } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  try {
    const stats = await getMetadataStats();
    return NextResponse.json(stats);
  } catch (e) {
    return NextResponse.json({ error: "db", message: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const rl = rateLimit(`ai-metadata:${clientIp(req)}`, 2, 60);
  if (!rl.ok) return tooMany(rl);
  try {
    const sp = req.nextUrl.searchParams;
    const maxTmdb = Math.min(600, Math.max(20, Number(sp.get("maxTmdb")) || 300));
    const batches = Math.min(8, Math.max(0, Number(sp.get("llmBatches")) || 4));
    const r = await runMetadataJob(maxTmdb, batches, 60);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: "job", message: String(e) }, { status: 500 });
  }
}
