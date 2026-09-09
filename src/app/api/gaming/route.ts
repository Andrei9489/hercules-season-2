import { NextRequest, NextResponse } from "next/server";
import { cachedFetch } from "@/lib/cache";

import { wrapPublicGet } from "@/lib/http-cache";
export type GameItem = {
  id: string;
  name: string;
  detail: string;
  image: string | null;
  category: string;
  source: string;
  extra?: Record<string, unknown>;
};

async function getHandler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") || "pokemon";

  try {
    if (mode === "pokemon") {
      const data = await cachedFetch<{
        results: { name: string; url: string }[];
      }>(`https://pokeapi.co/api/v2/pokemon?limit=50`, { ttl: 86400 });

      const details = await Promise.allSettled(
        data.results.slice(0, 24).map(async (p) => {
          const d = await cachedFetch<{
            id: number; name: string; height: number; weight: number;
            sprites: { front_default: string; other?: { "official-artwork"?: { front_default: string } } };
            types: { type: { name: string } }[];
            stats: { base_stat: number; stat: { name: string } }[];
          }>(p.url, { ttl: 86400 });
          return {
            id: String(d.id),
            name: d.name.charAt(0).toUpperCase() + d.name.slice(1),
            detail: `${d.types.map((t) => t.type.name).join(", ")} • H: ${d.height / 10}m • W: ${d.weight / 10}kg`,
            image:
              d.sprites?.other?.["official-artwork"]?.front_default ||
              d.sprites?.front_default ||
              null,
            category: "Pokémon",
            source: "pokeapi",
            extra: {
              stats: d.stats.map((s) => ({ name: s.stat.name, value: s.base_stat })),
            },
          } as GameItem;
        })
      );
      return NextResponse.json(
        details.filter((d) => d.status === "fulfilled").map((d) => (d as PromiseFulfilledResult<GameItem>).value)
      );
    }

    if (mode === "dota") {
      const [heroesRes, proMatchesRes] = await Promise.allSettled([
        cachedFetch<{ id: number; localized_name: string; img: string; attack_type: string; primary_attr: string }[]>(
          `https://api.opendota.com/api/heroStats`, { ttl: 86400 }
        ),
        cachedFetch<{ match_id: number; league_name: string; radiant_name: string; dire_name: string; radiant_win: boolean; duration: number }[]>(
          `https://api.opendota.com/api/proMatches`, { ttl: 300 }
        ),
      ]);
      const heroes =
        heroesRes.status === "fulfilled"
          ? [...heroesRes.value]
              .sort((a, b) => (a.id > b.id ? 1 : -1))
              .slice(0, 24)
              .map((h) => ({
                id: String(h.id),
                name: h.localized_name,
                detail: `${h.attack_type} • ${h.primary_attr.toUpperCase()}`,
                image: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${h.img.split("/").pop()?.replace("_png.png", ".png") || ""}`,
                category: "Dota 2 Hero",
                source: "opendota",
              } as GameItem))
          : [];
      const matches =
        proMatchesRes.status === "fulfilled"
          ? proMatchesRes.value.slice(0, 10).map((m) => ({
              id: String(m.match_id),
              competition: m.league_name,
              home: m.radiant_name || "Radiant",
              away: m.dire_name || "Dire",
              score: m.radiant_win ? "Radiant win" : "Dire win",
              date: "",
              status: "Final",
              sport: "Dota 2",
              source: "opendota",
            }))
          : [];
      return NextResponse.json({ heroes, matches });
    }

    if (mode === "steam") {
      // Steam featured games (public storefront API)
      try {
        const data = await cachedFetch<{
          featured_caps?: { id: number; large_capsule_image: string; name: string }[];
        }>(
          `https://store.steampowered.com/api/featuredcategories?cc=ro&l=english`, { ttl: 900 }
        );
        const featured = (data.featured_caps || []).slice(0, 24).map((g) => ({
          id: String(g.id),
          name: g.name,
          detail: "Joc Steam popular",
          image: g.large_capsule_image,
          category: "Steam",
          source: "steam",
        }));
        return NextResponse.json(featured);
      } catch {
        return NextResponse.json([]);
      }
    }

    if (mode === "minecraft") {
      const [mc] = await Promise.allSettled([
        cachedFetch<{ online: { online: boolean; players: number } }>(
          `https://api.mcsrvstat.us/3/mc.hypixel.net`, { ttl: 300 }
        ),
      ]);
      const status =
        mc.status === "fulfilled"
          ? { server: "Hypixel", online: mc.value.online?.online ?? false, players: mc.value.online?.players ?? 0 }
          : { server: "Hypixel", online: false, players: 0 };
      return NextResponse.json([status]);
    }

    return NextResponse.json({ error: "Mod necunoscut" }, { status: 400 });
  } catch (e) {
    console.error("Gaming route error:", e);
    return NextResponse.json({ error: "Eroare gaming" }, { status: 502 });
  }
}

// Faza 17a — edge cache public (CDN) + metrics Prometheus pentru gaming
export const GET = wrapPublicGet("gaming", getHandler, { sMaxage: 300, swr: 600 });
