import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

import { wrapPublicGet } from "@/lib/http-cache";
async function getHandler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") || "quote";

  try {
    if (mode === "quote") {
      const data = await cachedFetch<{ content: string; author: string; tags: string[] }>(
        "https://api.quotable.io/random", { ttl: 60, timeoutMs: 6000 }
      );
      return NextResponse.json({ quote: data.content, author: data.author, tags: data.tags });
    }

    if (mode === "joke") {
      const data = await cachedFetch<{
        error: boolean; type: string; setup?: string; delivery?: string; joke?: string; category: string;
      }>("https://v2.jokeapi.dev/joke/Any?safe-mode", { ttl: 30, timeoutMs: 6000 });
      return NextResponse.json({
        type: data.type,
        setup: data.setup || data.joke || "",
        delivery: data.delivery || "",
        category: data.category,
      });
    }

    if (mode === "trivia") {
      const amount = sp.get("amount") || "6";
      const cat = sp.get("category") || "";
      const url = `https://opentdb.com/api.php?amount=${amount}&type=multiple${cat ? `&category=${cat}` : ""}`;
      const data = await cachedFetch<{
        results: {
          question: string; correct_answer: string;
          incorrect_answers: string[]; category: string; difficulty: string;
        }[];
      }>(url, { ttl: 300 });
      const decoded = (s: string) =>
        s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&eacute;/g, "é");
      return NextResponse.json(
        (data.results || []).map((q, i) => ({
          id: i,
          question: decoded(q.question),
          correct: decoded(q.correct_answer),
          answers: [q.correct_answer, ...q.incorrect_answers]
            .map(decoded)
            .sort(() => Math.random() - 0.5),
          category: q.category,
          difficulty: q.difficulty,
        }))
      );
    }

    return NextResponse.json({ error: "Mod necunoscut" }, { status: 400 });
  } catch (e) {
    console.error("Fun route error:", e);
    return NextResponse.json({ error: "Eroare fun" }, { status: 502 });
  }
}

// Faza 17a — edge cache public (CDN) + metrics Prometheus pentru fun
export const GET = wrapPublicGet("fun", getHandler, { sMaxage: 300, swr: 600 });
