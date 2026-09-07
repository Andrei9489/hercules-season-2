"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Bookmark, Heart, History, Trash2 } from "lucide-react";
import type { MediaItem, UserItem } from "./types";
import { api } from "./api";
import { MediaCard } from "./MediaCard";

type Tab = "watchlist" | "favorites" | "history";

type Props = {
  authed: boolean;
  onOpen: (i: MediaItem) => void;
  onPlay: (i: MediaItem) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
  refreshKey: number;
};

function toMedia(u: UserItem): MediaItem {
  return {
    id: u.mediaId, mediaType: u.mediaType, title: u.title, poster: u.poster,
    backdrop: u.backdrop || null, overview: "", year: u.year || "",
    rating: u.rating || 0, source: u.source || "tmdb",
  };
}

export function MyListView({ authed, onOpen, onPlay, isSaved, onToggleList, refreshKey }: Props) {
  const [tab, setTab] = useState<Tab>("watchlist");
  const [items, setItems] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!authed) { setItems([]); setLoading(false); return; }
    setLoading(true);
    try {
      const r = await api.user<{ items: UserItem[] }>(tab);
      setItems(r.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tab, authed]);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (!authed) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-4 text-5xl">🔒</div>
        <h2 className="text-xl font-black">Conectează-te pentru lista ta</h2>
        <p className="mt-2 max-w-md text-sm text-zinc-500">
          Favorite, watchlist și istoricul de vizionare se salvează în contul tău pe toate dispozitivele.
        </p>
      </div>
    );
  }

  const clearHistory = async () => {
    try {
      await api.userPost({ action: "clear", kind: "history" });
      setItems([]);
    } catch {
      // silent
    }
  };

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-4 text-2xl font-black tracking-tight">📋 Lista Mea</h1>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {([
          { k: "watchlist", l: "🔖 Watchlist", icon: Bookmark },
          { k: "favorites", l: "❤️ Favorite", icon: Heart },
          { k: "history", l: "🕐 Vizionate", icon: History },
        ] as { k: Tab; l: string; icon: typeof Bookmark }[]).map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition ${
              tab === t.k ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            <t.icon className="h-3.5 w-3.5" /> {t.l}
          </button>
        ))}
        {tab === "history" && items.length > 0 && (
          <button
            onClick={clearHistory}
            className="ml-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold text-zinc-500 hover:text-red-400 transition"
          >
            <Trash2 className="h-3.5 w-3.5" /> Golește istoricul
          </button>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">
          {tab === "history" ? "Nimic vizionat încă — apasă Redă pe un titlu!" : "Lista este goală. Adaugă titluri cu butonul +."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {items.map((u) => (
            <MediaCard
              key={u.id}
              item={toMedia(u)}
              onOpen={onOpen}
              onPlay={onPlay}
              saved={isSaved(toMedia(u), "watchlist")}
              fav={isSaved(toMedia(u), "favorites")}
              onToggleList={(m) => onToggleList(m, "watchlist")}
              width="w-full"
            />
          ))}
        </div>
      )}
    </div>
  );
}
