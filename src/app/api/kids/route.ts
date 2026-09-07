import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

export type KidItem = {
  id: string;
  name: string;
  detail: string;
  image: string | null;
  category: string;
  source: string;
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") || "ghibli";

  try {
    if (mode === "ghibli") {
      const data = await cachedFetch<
        { id: string; title: string; description: string; image: string; release_date: string; rt_score: string; director: string }[]
      >(`https://ghibliapi.vercel.app/films`, { ttl: 86400 });
      const items: KidItem[] = data.map((f) => ({
        id: f.id,
        name: f.title,
        detail: `${f.release_date} • ${f.director} • Scor: ${f.rt_score}%`,
        image: f.image,
        category: "Studio Ghibli",
        source: "ghibli",
      }));
      return NextResponse.json(items);
    }

    if (mode === "waifu") {
      // Random wholesome images for kids section
      const images = await Promise.allSettled(
        Array.from({ length: 6 }).map(() =>
          cachedFetch<{ url: string[] }>(`https://api.waifu.pics/sfw/waifu`, { ttl: 0, timeoutMs: 5000 })
        )
      );
      const items: KidItem[] = images
        .filter((r) => r.status === "fulfilled")
        .map((r, i) => {
          const v = (r as PromiseFulfilledResult<{ url: string[] }>).value;
          return {
            id: `waifu-${i}`,
            name: "Ilustrație Anime",
            detail: "Imagine sfw de la waifu.pics",
            image: v.url?.[0] || null,
            category: "Anime Art",
            source: "waifu.pics",
          } as KidItem;
        });
      return NextResponse.json(items);
    }

    if (mode === "nekos") {
      const data = await cachedFetch<{ url: string }[]>(
        `https://nekos.best/api/v2/neko?amount=8`, { ttl: 0, timeoutMs: 6000 }
      );
      const items: KidItem[] = (data || []).map((n, i) => ({
        id: `neko-${i}`,
        name: "Artă Anime",
        detail: "Ilustrație de la nekos.best",
        image: n.url,
        category: "Anime Art",
        source: "nekos.best",
      }));
      return NextResponse.json(items);
    }

    if (mode === "catboy") {
      const images = await Promise.allSettled(
        Array.from({ length: 6 }).map(() =>
          cachedFetch<{ url: string; artist?: string }>(`https://api.catboys.com/img`, { ttl: 0, timeoutMs: 5000 })
        )
      );
      const items: KidItem[] = images
        .filter((r) => r.status === "fulfilled")
        .map((r, i) => {
          const v = (r as PromiseFulfilledResult<{ url: string; artist?: string }>).value;
          return {
            id: `catboy-${i}`,
            name: "Artă Catboy",
            detail: v.artist ? `Artist: ${v.artist}` : "Ilustrație de la catboys API",
            image: v.url,
            category: "Anime Art",
            source: "catboys",
          } as KidItem;
        });
      return NextResponse.json(items);
    }

    if (mode === "poke") {
      const data = await cachedFetch<{ results: { name: string; url: string }[] }>(
        `https://pokeapi.co/api/v2/pokemon?limit=25`, { ttl: 86400 }
      );
      const details = await Promise.allSettled(
        data.results.map(async (p) => {
          const d = await cachedFetch<{
            id: number; name: string;
            sprites: { front_default: string; other?: { "official-artwork"?: { front_default: string } } };
            types: { type: { name: string } }[];
          }>(p.url, { ttl: 86400 });
          return {
            id: String(d.id),
            name: d.name.charAt(0).toUpperCase() + d.name.slice(1),
            detail: d.types.map((t) => t.type.name).join(", "),
            image: d.sprites?.other?.["official-artwork"]?.front_default || d.sprites?.front_default,
            category: "Pokémon",
            source: "pokeapi",
          } as KidItem;
        })
      );
      return NextResponse.json(
        details.filter((d) => d.status === "fulfilled").map((d) => (d as PromiseFulfilledResult<KidItem>).value)
      );
    }

    return NextResponse.json({ error: "Mod necunoscut" }, { status: 400 });
  } catch (e) {
    console.error("Kids route error:", e);
    return NextResponse.json({ error: "Eroare kids" }, { status: 502 });
  }
}
