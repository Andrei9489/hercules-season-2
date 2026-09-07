// Faza 7 — AI RECOMANDĂRI
// GET /api/ai/recommend                → global diversificat
// GET /api/ai/recommend?seed=<id>      → similar cu un conținut (genuri comune)
// GET /api/ai/recommend?personal=1     → personalizat din istoricul sesiunii
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { recommendBySeed, recommendForUser, recommendGlobal } from "@/lib/ai-engine";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(20, Math.max(2, Number(sp.get("limit")) || 10));
    const seed = Number(sp.get("seed")) || 0;

    if (seed > 0) {
      const items = await recommendBySeed(seed, limit);
      return NextResponse.json({ items, mode: "seed" });
    }

    if (sp.get("personal") === "1") {
      const session = await getServerSession(authOptions).catch(() => null);
      const email = session?.user?.email;
      if (email) {
        const items = await recommendForUser(email, limit);
        return NextResponse.json({ items, mode: "personal" });
      }
    }

    const items = await recommendGlobal(limit);
    return NextResponse.json({ items, mode: "global" });
  } catch (e) {
    return NextResponse.json({ error: "db", message: String(e) }, { status: 500 });
  }
}
