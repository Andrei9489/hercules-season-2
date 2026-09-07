// Faza 7 — GENURI & CATEGORII AI
// GET  → taxonomia creată automat de AI (genuri, categorii, ani,
//        decenii, studiouri, francize, colecții, trilogii)
// POST → rulează job-ul AI de extragere/genare taxonomie din conținut
import { NextRequest, NextResponse } from "next/server";
import { getTaxonomy, getTaxonomyCounts } from "@/lib/ai-engine";
import { runGenresJob } from "@/lib/ai-jobs";
import { clientIp, rateLimit, tooMany } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  try {
    const [taxonomy, counts] = await Promise.all([getTaxonomy(30), getTaxonomyCounts()]);
    return NextResponse.json({ taxonomy, counts });
  } catch (e) {
    return NextResponse.json({ error: "db", message: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const rl = rateLimit(`ai-genres:${clientIp(req)}`, 2, 60);
  if (!rl.ok) return tooMany(rl);
  try {
    const r = await runGenresJob();
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: "job", message: String(e) }, { status: 500 });
  }
}
