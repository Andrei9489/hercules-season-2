import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

const OS_KEY = process.env.OPENSUBTITLES_API_KEY || "iHdrgVgNTYZQXZhW75Clfa62A5knFn7n";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const tmdbId = sp.get("tmdbId");
  const query = sp.get("query");
  const lang = sp.get("lang") || "ro";

  try {
    const params = new URLSearchParams({ languages: lang });
    if (tmdbId) params.set("tmdb_id", tmdbId);
    if (query) params.set("query", query);

    const data = await cachedFetch<{
      data?: {
        id: string;
        attributes: {
          release: string;
          files?: { file_name?: string; file_id?: number }[];
          download_count?: number;
        };
      }[];
    }>(`https://api.opensubtitles.com/api/v1/subtitles?${params}`, {
      ttl: 600,
      headers: { "Api-Key": OS_KEY, "User-Agent": "StreamVerse v1.0" },
      timeoutMs: 8000,
    });

    const items = (data.data || []).slice(0, 10).map((s) => ({
      id: s.id,
      release: s.attributes?.release || "Necunoscut",
      fileName: s.attributes?.files?.[0]?.file_name || "",
      downloads: s.attributes?.download_count || 0,
    }));
    return NextResponse.json(items);
  } catch (e) {
    console.error("Subtitles route error:", e);
    return NextResponse.json(
      { error: "Subtitrările nu sunt disponibile momentan" },
      { status: 502 }
    );
  }
}
