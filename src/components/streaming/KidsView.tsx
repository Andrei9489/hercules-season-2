"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { MediaItem, KidItem } from "./types";
import { api } from "./api";
import { MediaCard } from "./MediaCard";

type Props = {
  initialBrand?: string;
  onPlay: (i: MediaItem) => void;
  onOpen: (i: MediaItem) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
};

// Toate brandurile cerute — Kids & Cartoon channels
const BRAND_TABS = [
  { key: "disney", label: "🏰 Disney", desc: "Clasicele Disney" },
  { key: "pixar", label: "🎨 Pixar", desc: "Animație Pixar" },
  { key: "cartoon-network", label: "📺 Cartoon Network", desc: "Seriale CN" },
  { key: "jetix", label: "⚡ Jetix", desc: "Clasicele Jetix" },
  { key: "fox-kids", label: "🦊 Fox Kids", desc: "Retro Fox Kids" },
  { key: "boomerang", label: "🌀 Boomerang", desc: "Cartooni clasici" },
  { key: "minimax", label: "🌈 Minimax", desc: "Desene Minimax" },
  { key: "ghibli", label: "🌱 Ghibli", desc: "Magia Ghibli" },
];

type BrandResponse = {
  brand: { id: string; name: string; emoji: string; accent: string };
  items: MediaItem[];
};

export function KidsView({ initialBrand, onPlay, onOpen, isSaved, onToggleList }: Props) {
  const [brand, setBrand] = useState(
    BRAND_TABS.some((b) => b.key === initialBrand) ? (initialBrand as string) : "disney"
  );
  const [data, setData] = useState<{ brand: string; items: MediaItem[] } | null>(null);
  const loading = !data || data.brand !== brand;

  useEffect(() => {
    let cancelled = false;
    api.tmdb<BrandResponse>(`mode=brand&brand=${brand}`)
      .then((r) => { if (!cancelled) setData({ brand, items: r.items }); })
      .catch(() => { if (!cancelled) setData({ brand, items: [] }); });
    return () => { cancelled = true; };
  }, [brand]);

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-1 text-2xl font-black tracking-tight">🧸 Copii & Desene Animate</h1>
      <p className="mb-5 text-sm text-zinc-500">
        Disney, Pixar, Cartoon Network, Jetix, Fox Kids, Boomerang, Minimax și Studio Ghibli — toate într-un singur loc.
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        {BRAND_TABS.map((b) => (
          <button
            key={b.key}
            onClick={() => setBrand(b.key)}
            title={b.desc}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              brand === b.key
                ? "bg-white text-black shadow"
                : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : data.items.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">Niciun conținut pentru acest brand.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {data.items.map((i) => (
            <MediaCard key={`${i.mediaType}-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")}
              onToggleList={(m) => onToggleList(m, "watchlist")} width="w-full" />
          ))}
        </div>
      )}

      <KidsExtras />
    </div>
  );
}

function KidsExtras() {
  const [pokemons, setPokemons] = useState<KidItem[]>([]);
  const [ghibliImgs, setGhibliImgs] = useState<KidItem[]>([]);

  useEffect(() => {
    api.kids<KidItem[]>("mode=poke").then(setPokemons).catch(() => {});
    api.kids<KidItem[]>("mode=nekos").then(setGhibliImgs).catch(() => {});
  }, []);

  return (
    <div className="mt-10 space-y-8">
      {pokemons.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-bold">⚡ Lumea Pokémon</h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-8">
            {pokemons.slice(0, 24).map((p) => (
              <div key={p.id} className="rounded-xl bg-zinc-900/70 p-3 text-center ring-1 ring-zinc-800 hover:ring-yellow-600/50 transition">
                {p.image && (
                   
                  <img src={p.image} alt={p.name} loading="lazy" className="mx-auto h-20 w-20 object-contain" />
                )}
                <p className="mt-2 truncate text-xs font-bold text-zinc-200">{p.name}</p>
                <p className="text-[10px] capitalize text-zinc-500">{p.detail}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {ghibliImgs.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-bold">🖼️ Artă anime (nekos.best)</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {ghibliImgs.slice(0, 8).map((k, i) => (
              k.image ? (
                 
                <img key={i} src={k.image} alt={k.name} loading="lazy" className="aspect-[2/3] w-full rounded-xl object-cover ring-1 ring-zinc-800" />
              ) : null
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
