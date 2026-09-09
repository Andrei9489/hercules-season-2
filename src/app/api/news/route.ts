import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

import { wrapPublicGet } from "@/lib/http-cache";
// RSS aggregator: BBC, CNN, NHK, Al Jazeera (+ Tech & Sport)
type NewsItem = {
  id: string;
  title: string;
  description: string;
  link: string;
  image: string | null;
  source: string;
  date: string;
};

const FEEDS: Record<string, { url: string; name: string }> = {
  bbc: { url: "https://feeds.bbci.co.uk/news/world/rss.xml", name: "BBC World" },
  cnn: { url: "http://rss.cnn.com/rss/edition.rss", name: "CNN" },
  nhk: { url: "https://www3.nhk.or.jp/nhkworld/en/news/rss/all.xml", name: "NHK World" },
  aljazeera: { url: "https://www.aljazeera.com/xml/rss/all.xml", name: "Al Jazeera" },
  entertainment: { url: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml", name: "BBC Show-biz" },
  tech: { url: "https://feeds.bbci.co.uk/news/technology/rss.xml", name: "BBC Tech" },
  sport: { url: "https://feeds.bbci.co.uk/sport/rss.xml", name: "BBC Sport" },
};

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

function stripHtml(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}

async function getHandler(req: NextRequest) {
  const feed = req.nextUrl.searchParams.get("feed") || "bbc";

  try {
    const conf = FEEDS[feed];
    if (!conf) return NextResponse.json({ error: "Feed necunoscut" }, { status: 400 });

    const res = await fetch(conf.url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const xml = await res.text();

    const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    const items: NewsItem[] = itemBlocks.slice(0, 20).map((block, i) => {
      const title = stripHtml(extractTag(block, "title"));
      const description = stripHtml(extractTag(block, "description")).slice(0, 300);
      const link = stripHtml(extractTag(block, "link")) || extractTag(block, "guid");
      const pubDate = stripHtml(extractTag(block, "pubDate"));
      const mediaUrl =
        block.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1] ||
        block.match(/<media:content[^>]*url="([^"]+)"/)?.[1] ||
        block.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/)?.[1] ||
        null;
      return {
        id: `${feed}-${i}`,
        title,
        description,
        link,
        image: mediaUrl,
        source: conf.name,
        date: pubDate,
      };
    });
    return NextResponse.json(items);
  } catch (e) {
    console.error("News route error:", e);
    return NextResponse.json({ error: "Eroare la feed" }, { status: 502 });
  }
}

// Faza 17a — edge cache public (CDN) + metrics Prometheus pentru news
export const GET = wrapPublicGet("news", getHandler, { sMaxage: 60, swr: 180 });
