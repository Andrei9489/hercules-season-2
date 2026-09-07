"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { MediaItem } from "./types";
import { api } from "./api";
import { MediaCard } from "./MediaCard";

type Props = {
  initialTab?: string;
  onPlay: (i: MediaItem) => void;
  onOpen: (i: MediaItem) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
};

const UNIVERSE_TABS = [
  { key: "marvel", label: "🦸 Marvel", desc: "Universul cinematografic Marvel", api: "brand" },
  { key: "dc", label: "🦇 DC", desc: "Universul DC Comics", api: "brand" },
  { key: "blockbuster", label: "💥 Blockbustere", desc: "Cele mai mari filme ale lumii", api: "blockbuster" },
] as const;

type TabKey = (typeof UNIVERSE_TABS)[number]["key"];

export function UniversuriView({ initialTab = "marvel", onPlay, onOpen, isSaved, onToggleList }: Props) {
  const [tab, setTab] = useState<TabKey>(
    (UNIVERSE_TABS.some((t) => t.key === initialTab) ? initialTab : "marvel") as TabKey
  );
  const [data, setData] = useState<{ tab: string; items: MediaItem[] } | null>(null);
  const loading = !data || data.tab !== tab;
  const name = UNIVERSE_TABS.find((t) => t.key === tab)?.label || "";

  useEffect(() => {
    let cancelled = false;
    const qs = tab === "blockbuster" ? "mode=blockbuster" : `mode=brand&brand=${tab}`;
    api.tmdb<{ items?: MediaItem[]; brand?: { name: string } }>(qs)
      .then((r) => { if (!cancelled) setData({ tab, items: r.items || [] }); })
      .catch(() => { if (!cancelled) setData({ tab, items: [] }); });
    return () => { cancelled = true; };
  }, [tab]);

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-1 text-2xl font-black tracking-tight">🌌 Universuri</h1>
      <p className="mb-5 text-sm text-zinc-500">
        Marvel, DC Comics și cele mai mari blockbustere din industria globală de cinema — metadata reală TMDB.
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        {UNIVERSE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            title={t.desc}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              tab === t.key
                ? "bg-white text-black shadow"
                : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {Array.from({ length: 14 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : data.items.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">Niciun conținut pentru acest univers.</p>
      ) : (
        <>
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-600">{name}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
            {data.items.map((i) => (
              <MediaCard key={`${i.mediaType}-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
                saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")}
                onToggleList={(m) => onToggleList(m, "watchlist")} width="w-full" />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
