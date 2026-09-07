"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { MediaItem, UserItem, LibraryItem } from "./types";
import { api } from "./api";
import { Hero } from "./Hero";
import { Row } from "./Row";
import { MediaCard } from "./MediaCard";
import { CapacityPanel } from "./CapacityPanel";
import { LibraryAddDialog } from "./LibraryAddDialog";
import { AIHub } from "./AIHub";
import { PlayCircle, PlusCircle, Sparkles } from "lucide-react";

type RecItem = {
  id: number; title: string; contentType: string; description: string;
  thumbnail: string | null; backdrop: string | null; year: number | null;
  rating: number; views: number; shared: number; reason: string;
};

type Props = {
  onPlay: (i: MediaItem) => void;
  onOpen: (i: MediaItem) => void;
  onNavigate: (v: string) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
  authed: boolean;
};

export function HomeView({ onPlay, onOpen, onNavigate, isSaved, onToggleList, authed }: Props) {
  const [trending, setTrending] = useState<MediaItem[]>([]);
  const [movies, setMovies] = useState<MediaItem[]>([]);
  const [series, setSeries] = useState<MediaItem[]>([]);
  const [anime, setAnime] = useState<MediaItem[]>([]);
  const [blockbusters, setBlockbusters] = useState<MediaItem[]>([]);
  const [recs, setRecs] = useState<RecItem[]>([]);
  const [recMode, setRecMode] = useState("");
  const [history, setHistory] = useState<UserItem[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadLibrary = useCallback(() => {
    api.library<{ items: LibraryItem[]; total: number }>("limit=18&facets=1")
      .then((r) => {
        setLibrary(r.items);
        setLibraryTotal(r.total);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      const results = await Promise.allSettled([
        api.tmdb<MediaItem[]>("mode=trending&window=week"),
        api.tmdb<MediaItem[]>("mode=list&kind=popular&type=movie"),
        api.tmdb<MediaItem[]>("mode=list&kind=airing_today&type=tv"),
        api.anime<MediaItem[]>("mode=airing"),
        api.tmdb<MediaItem[]>("mode=discover&type=movie&genre=actiune&year=2025"),
      ]);
      setTrending(results[0].status === "fulfilled" ? results[0].value.slice(0, 10) : []);
      setMovies(results[1].status === "fulfilled" ? results[1].value.slice(0, 18) : []);
      setSeries(results[2].status === "fulfilled" ? results[2].value.slice(0, 18) : []);
      setAnime(results[3].status === "fulfilled" ? results[3].value.slice(0, 18) : []);
      setBlockbusters(results[4].status === "fulfilled" ? results[4].value.slice(0, 18) : []);
      setLoading(false);
    })();
    loadLibrary();
  }, [loadLibrary]);

  // Faza 7: AI RECOMANDARI — personalizate (istoric Neon) dacă ești logat,
  // altfel mix global diversificat calculat de AI din popularitate reală
  useEffect(() => {
    api.aiRecommend<{ items: RecItem[]; mode: string }>(authed ? "personal=1&limit=12" : "limit=12")
      .then((r) => { setRecs(r.items || []); setRecMode(r.mode); })
      .catch(() => {});
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    api.user<{ items: UserItem[] }>("history")
      .then((r) => setHistory(r.items.slice(0, 12)))
      .catch(() => {});
  }, [authed]);

  const heroItems = trending.slice(0, 5).filter((t) => t.backdrop || t.poster);

  const toggle = (i: MediaItem, k: "watchlist" | "favorites") => onToggleList(i, k);

  const libToMedia = (l: LibraryItem): MediaItem => ({
    id: String(l.id),
    mediaType: "neon",
    title: l.title,
    poster: l.thumbnail,
    backdrop: l.backdrop,
    overview: l.description,
    year: l.year ? String(l.year) : "",
    rating: l.rating,
    source: "neon",
    sourceUrl: l.sourceUrl,
    embedCode: l.embedCode,
    provider: l.provider,
    neonId: l.id,
  });

  const playLibrary = (l: LibraryItem) => onPlay(libToMedia(l));

  const openLibraryDetail = (l: LibraryItem) => onOpen(libToMedia(l));

  if (loading) {
    return (
      <div className="space-y-6 pt-4">
        <Skeleton className="mx-4 h-[420px] rounded-2xl sm:mx-6" />
        <div className="space-y-3 px-4 sm:px-6">
          <Skeleton className="h-5 w-48" />
          <div className="flex gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-64 w-36 shrink-0 rounded-xl sm:w-40 lg:w-44" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <Hero items={heroItems} onPlay={onPlay} onOpen={onOpen} />

      <div className="relative z-10 -mt-8 space-y-7 pt-2">
        <CapacityPanel />

        {/* Faza 7: AI RECOMANDARI */}
        {recs.length > 0 && (
          <Row title={`🤖 AI Recomandări${recMode === "personal" ? " pentru tine — din istoricul tău" : " — mix global calculat de AI"}`}>
            {recs.map((r) => {
              const m: MediaItem = {
                id: String(r.id), mediaType: "neon", title: r.title, poster: r.thumbnail,
                backdrop: r.backdrop, overview: r.description, year: r.year ? String(r.year) : "",
                rating: r.rating, source: "neon", neonId: r.id,
              };
              return (
                <div key={`rec-${r.id}`} className="w-36 shrink-0 sm:w-40 lg:w-44">
                  <MediaCard item={m} onOpen={onOpen} onPlay={onPlay} width="w-full"
                    saved={isSaved(m, "watchlist")} fav={isSaved(m, "favorites")} onToggleList={(mm) => toggle(mm, "watchlist")} />
                  <p className="truncate text-[10px] text-amber-500/80">
                    <Sparkles className="mr-0.5 inline h-2.5 w-2.5" />{r.reason}{r.shared > 0 ? ` (${r.shared})` : ""}
                  </p>
                </div>
              );
            })}
          </Row>
        )}

        {authed && history.length > 0 && (
          <Row title="▶ Continuă vizionarea" onMore={() => onNavigate("lista")}>
            {history.map((h) => (
              <div key={h.id} className="relative w-36 shrink-0 sm:w-40 lg:w-44 cursor-pointer group" onClick={() => onOpen({
                id: h.mediaId, mediaType: h.mediaType, title: h.title, poster: h.poster,
                backdrop: h.backdrop, overview: "", year: h.year || "", rating: h.rating || 0, source: h.source || "tmdb",
              })}>
                <div className="relative aspect-video rounded-xl overflow-hidden bg-zinc-800 ring-1 ring-white/10">
                  {h.backdrop || h.poster ? (
                     
                    <img src={h.backdrop || h.poster || ""} alt={h.title} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-3xl">🎬</div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
                    <PlayCircle className="h-10 w-10 text-white drop-shadow" />
                  </div>
                  {h.progress != null && h.progress > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-700">
                      <div className="h-full bg-red-600" style={{ width: `${Math.min(95, (h.progress / 600) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <p className="mt-1.5 truncate text-[13px] font-medium">{h.title}</p>
              </div>
            ))}
          </Row>
        )}

        <Row
          title={`🧠 Biblioteca Neon — redare universală din orice sursă (${libraryTotal.toLocaleString("ro-RO")})`}
        >
          <div className="flex shrink-0 items-center">
            <button
              onClick={() => setAddOpen(true)}
              className="flex h-[176px] w-28 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-700 text-zinc-500 transition hover:border-red-600/60 hover:text-red-400 sm:w-32 lg:w-36"
            >
              <PlusCircle className="h-8 w-8" />
              <span className="px-2 text-center text-[11px] font-bold leading-tight">Adaugă conținut</span>
              <span className="px-2 text-center text-[10px] leading-tight text-zinc-600">URL • Embed • iframe • JS</span>
            </button>
          </div>
          {library.map((l) => (
            <div key={`lib-${l.id}`} className="w-36 shrink-0 sm:w-40 lg:w-44">
              <button
                onClick={() => playLibrary(l)}
                className="group relative block aspect-video w-full cursor-pointer overflow-hidden rounded-xl bg-zinc-800 ring-1 ring-white/10"
              >
                {l.thumbnail ? (
                  <img src={l.thumbnail} alt={l.title} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-full items-center justify-center text-3xl">🎬</div>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
                  <PlayCircle className="h-10 w-10 text-white drop-shadow" />
                </div>
                <span className="absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-300">
                  {l.provider}
                </span>
                {l.views > 0 && (
                  <span className="absolute right-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-bold text-zinc-200">
                    ▶ {l.views}
                  </span>
                )}
              </button>
              <button onClick={() => openLibraryDetail(l)} className="mt-1.5 block w-full cursor-pointer truncate text-left text-[13px] font-medium hover:text-red-400">
                {l.title}
              </button>
              <p className="truncate text-[10px] text-zinc-600">
                {l.contentType} • {l.country || l.continent || "Global"} • {l.sourceType}
              </p>
            </div>
          ))}
        </Row>

        <Row title="🔥 Trending acum — global" onMore={() => onNavigate("filme")}>
          {trending.map((i) => (
            <MediaCard key={`t-${i.mediaType}-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        <Row title="🍿 Filme populare" onMore={() => onNavigate("filme")}>
          {movies.map((i) => (
            <MediaCard key={`m-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        <Row title="📺 Seriale difuzate azi" onMore={() => onNavigate("seriale")}>
          {series.map((i) => (
            <MediaCard key={`s-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        <Row title="🌸 Anime în emisiune" onMore={() => onNavigate("anime")}>
          {anime.map((i) => (
            <MediaCard key={`a-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        <Row title="💥 Blockbustere de acțiune" onMore={() => onNavigate("filme")}>
          {blockbusters.map((i) => (
            <MediaCard key={`b-${i.id}`} item={i} onOpen={onOpen} onPlay={onPlay}
              saved={isSaved(i, "watchlist")} fav={isSaved(i, "favorites")} onToggleList={(m) => toggle(m, "watchlist")} />
          ))}
        </Row>

        {/* Faza 7: AI HUB — analiză live + genuri AI + paginare infinită + metadate */}
        <AIHub onPlay={onPlay} onOpen={onOpen} isSaved={isSaved} onToggleList={onToggleList} authed={authed} />
      </div>

      <LibraryAddDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => loadLibrary()}
      />
    </div>
  );
}
