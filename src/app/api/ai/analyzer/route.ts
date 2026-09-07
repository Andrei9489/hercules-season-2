// Faza 7 — AI ANALIZATOR: analizează tot conținutul platformei și
// salvează snapshot-uri succesive în Neon (istoric permanent).
// GET  → cel mai recent snapshot (citiri pe pool RO)
// POST → re-analiză live (agregări SQL reale + rezumat AI)
import { NextRequest, NextResponse } from "next/server";
import { getLatestAnalyzer, runAnalyzer } from "@/lib/ai-engine";
import { clientIp, rateLimit, tooMany } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snap = await getLatestAnalyzer();
    return NextResponse.json({ snapshot: snap }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: "db", message: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const rl = rateLimit(`ai-analyzer:${clientIp(req)}`, 4, 10);
  if (!rl.ok) return tooMany(rl);
  try {
    const snap = await runAnalyzer(true);
    return NextResponse.json({ snapshot: snap });
  } catch (e) {
    return NextResponse.json({ error: "db", message: String(e) }, { status: 500 });
  }
}
