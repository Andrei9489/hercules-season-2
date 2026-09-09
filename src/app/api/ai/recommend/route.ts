// Faza 7 — AI RECOMANDĂRI (rută)
// Faza 18b — motor v2 (era multi-shard):
//   GET /api/ai/recommend                → global diversificat, colectat de pe TOATE compute-urile active
//   GET /api/ai/recommend?seed=<id>      → similar cu un conținut (genuri + titlu cross-shard)
//   GET /api/ai/recommend?personal=1     → personalizat: History+Watchlist+Favorite + co-watch + L2 în Neon
// FIX Faza 18: emailul sesiunii se rezolvă la User.id (History/Watchlist/Favorite
// stochează User.id, NU emailul) — înainte filtrul după email nu găsea nimic.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getUserIdByEmail } from "@/lib/auth";
import { recommendBySeedV2, recommendForUserV2, recommendGlobalV2 } from "@/lib/recommendations";
import { recordRequest } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const code = (n: number) => {
    recordRequest("recommend", n, Date.now() - t0, n >= 500 ? "error" : "origin");
    return n;
  };
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(20, Math.max(2, Number(sp.get("limit")) || 10));
    const seed = Number(sp.get("seed")) || 0;

    if (seed > 0) {
      const r = await recommendBySeedV2(seed, limit);
      return NextResponse.json({ ...r, tookMs: Date.now() - t0 });
    }

    if (sp.get("personal") === "1") {
      const session = await getServerSession(authOptions).catch(() => null);
      const email = session?.user?.email;
      if (email) {
        // FIX Faza 18: rezolvăm User.id din email — tabelele de user stochează User.id
        const userId = await getUserIdByEmail(email).catch(() => null);
        if (userId) {
          const r = await recommendForUserV2(userId, limit);
          return NextResponse.json({ ...r, tookMs: Date.now() - t0 });
        }
      }
    }

    const r = await recommendGlobalV2(limit);
    return NextResponse.json({ ...r, tookMs: Date.now() - t0 });
  } catch (e) {
    return NextResponse.json({ error: "db", message: String(e) }, { status: code(500) });
  }
}
