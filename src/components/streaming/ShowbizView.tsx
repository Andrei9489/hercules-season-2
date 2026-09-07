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

// Fiecare tab = un gen TMDB real (metadata autentică)
const SHOWBIZ_TABS = [
  { key: "divertisment", label: "🎭 Divertisment", desc: "Comedii & varietăți TV", type: "tv", genre: "comedie" },
  { key: "showbiz", label: "⭐ Show-biz", desc: "Talk show-uri & celebrități", type: "tv", genre: "talk" },
  { key: "reality", label: "🎤 Reality TV", desc: "Reality show-uri globale", type: "tv", genre: "reality" },
  { key: "emisiuni", label: "🎙️ Emisiuni TV", desc: "Dezbateri & emisiuni de actualitate", type: "tv", genre: "stiri" },
] as const;

type TabKey = (typeof SHOWBIZ_TABS)[number]["key"];

export function ShowbizView({ initialTab = "divertisment", onPlay, onOpen, isSaved, onToggleList }: Props) {
  const [tab, setTab] = useState<TabKey>(
    (SHOWBIZ_TABS.some((t) => t.key === initialTab) ? initialTab : "divertisment") as TabKey
  );
  const [data, setData] = useState<{ tab: string; items: MediaItem[] } | null>(null);
  const loading = !data || data.tab !== tab;
  const active = SHOWBIZ_TABS.find((t) => t.key === tab)!;

  useEffect(() => {
    let cancelled = false;
    api.tmdb<MediaItem[]>(`mode=discover&type=${active.type}&genre=${active.genre}`)
      .then((r) => { if (!cancelled) setData({ tab, items: Array.isArray(r) ? r : [] }); })
      .catch(() => { if (!cancelled) setData({ tab, items: [] }); });
    return () => { cancelled = true; };
  }, [active.type, active.genre, tab]);

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-1 text-2xl font-black tracking-tight">✨ TV &amp; Show-biz</h1>
      <p className="mb-5 text-sm text-zinc-500">
        Divertisment, show-biz, reality TV și emisiuni de televiziune — din toată lumea, metadata reală TMDB.
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        {SHOWBIZ_TABS.map((t) => (
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
        <p className="py-16 text-center text-sm text-zinc-500">Niciun conținut pentru această categorie.</p>
      ) : (
        <>
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-600">{active.desc}</p>
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
