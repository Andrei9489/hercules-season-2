import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

const YT_KEY = process.env.YOUTUBE_API_KEY || "AIzaSyAWJ0f6XdhPb3fJL6EYjB5ZamaoM1ZT1XM";

export type MusicItem = {
  id: string;
  kind: "song" | "video" | "album";
  title: string;
  artist: string;
  album: string | null;
  artwork: string | null;
  preview: string | null; // 30s preview (iTunes)
  youtubeKey: string | null;
  year: string;
  genre: string;
  source: string;
};

type ItunesResult = {
  trackId?: number;
  collectionId?: number;
  trackName?: string;
  collectionName?: string;
  artistName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  releaseDate?: string;
  primaryGenreName?: string;
  kind?: string;
};

async function youtubeSearch(q: string, max = 8): Promise<{ key: string; title: string; channel: string; thumb: string }[]> {
  try {
    const data = await cachedFetch<{
      items: {
        id: { videoId: string };
        snippet: { title: string; channelTitle: string; thumbnails: { high?: { url: string }; medium?: { url: string } } };
      }[];
    }>(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=${max}&q=${encodeURIComponent(q)}&key=${YT_KEY}`,
      { ttl: 1800 }
    );
    return (data.items || [])
      .filter((i) => i.id?.videoId)
      .map((i) => ({
        key: i.id.videoId,
        title: i.snippet.title,
        channel: i.snippet.channelTitle,
        thumb: i.snippet.thumbnails?.high?.url || i.snippet.thumbnails?.medium?.url || "",
      }));
  } catch (e) {
    console.error("YouTube search failed:", e);
    return [];
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") || "top";

  try {
    if (mode === "top" || mode === "search" || mode === "genre") {
      let q = sp.get("q") || "";
      if (mode === "top") q = sp.get("q") || "top hits 2026";
      if (mode === "genre") q = sp.get("genre") || "pop music";

      const [itunes, yt] = await Promise.all([
        cachedFetch<{ results: ItunesResult[] }>(
          `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=24`,
          { ttl: 1800 }
        ).catch(() => ({ results: [] as ItunesResult[] })),
        youtubeSearch(q),
      ]);

      const songs: MusicItem[] = itunes.results
        .filter((r) => r.trackName)
        .map((r) => ({
          id: String(r.trackId),
          kind: "song",
          title: r.trackName || "",
          artist: r.artistName || "",
          album: r.collectionName || null,
          artwork: r.artworkUrl100?.replace("100x100", "400x400") || null,
          preview: r.previewUrl || null,
          youtubeKey: null,
          year: (r.releaseDate || "").slice(0, 4),
          genre: r.primaryGenreName || "",
          source: "itunes",
        }));

      const videos: MusicItem[] = yt.map((v) => ({
        id: v.key,
        kind: "video",
        title: v.title,
        artist: v.channel,
        album: null,
        artwork: v.thumb,
        preview: null,
        youtubeKey: v.key,
        year: "",
        genre: "Muzică",
        source: "youtube",
      }));

      return NextResponse.json({ songs, videos });
    }

    if (mode === "lyrics") {
      const artist = sp.get("artist") || "";
      const track = sp.get("track") || "";
      if (!artist || !track) return NextResponse.json({ lyrics: null }, { status: 400 });
      try {
        const data = await cachedFetch<{ lyrics?: string }>(
          `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`,
          { ttl: 86400, timeoutMs: 6000 }
        );
        return NextResponse.json({ lyrics: data.lyrics || null });
      } catch {
        return NextResponse.json({ lyrics: null });
      }
    }

    if (mode === "artist") {
      const q = sp.get("q") || "";
      const data = await cachedFetch<{ results: ItunesResult[] }>(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=musicArtist&limit=5`,
        { ttl: 86400 }
      );
      return NextResponse.json(data.results);
    }

    return NextResponse.json({ error: "Mod necunoscut" }, { status: 400 });
  } catch (e) {
    console.error("Music route error:", e);
    return NextResponse.json({ error: "Eroare muzică" }, { status: 502 });
  }
}
