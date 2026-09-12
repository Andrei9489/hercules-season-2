"use client";

// ============================================================
// LibraryView — VIZUALIZAREA UNIVERSALĂ A BIBLIOTECII UTILIZATORULUI
// Faza 8: TOATE meniurile platformei (Filme, Seriale, Anime,
// Copii, Muzică, Documentare, Telenovele, Sport, Gaming, Știri,
// Radio, Show-biz, Universuri) folosesc ACEASTĂ componentă.
// Nu mai există view-uri cu conținut extern/simulat — tot ce se
// afișează vine exclusiv din Neon, adăugat de utilizator prin
// URL / iframe / embed / JS.
// Paginare AI: 20 postere/pagină, numerotată, next/prev.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { MediaItem } from "./types";
import { api } from "./api";
import { MediaCard } from "./MediaCard";
import { PlusCircle, ChevronLeft, ChevronRight, Database, Layers } from "lucide-react";

type BrowseItem = {
  id: number; title: string; description: string; contentType: string;
  brand: string | null; category: string | null; country: string | null;
  provider: string; sourceType: string; thumbnail: string | null;
  backdrop: string | null; year: number | null; rating: number;
  views: number; sourceUrl?: string | null; embedCode?: string | null;
  signed?: boolean;
};

type BrowseResp = {
  items: BrowseItem[]; page: number; size: number; total: number;
  totalPages: number; hasNext: boolean; hasPrev: boolean;
};

const SORTS: [string, string][] = [
  ["popularity", "🔥 Popularitate"],
  ["newest_added", "🆕 Adăugate recent"],
  ["views", "👁️ Cele mai redare"],
  ["rating", "⭐ Rating"],
  ["year", "📅 An"],
];

type Props = {
  title: string;
  emoji: string;
  description?: string;
  type?: string;          // filtru content_type (ex: movie, series, anime...)
  brand?: string;         // filtru brand fix (ex: marvel)
  brands?: [string, string][]; // tab-uri brand (Copii: Disney, Jetix...)
  // FAZA 39 — filtre pentru submeniuri (TV & Show-biz: categorie, Lumea: continent)
  category?: string;      // filtru category fix (ex: reality)
  continent?: string;     // filtru continent fix (ex: Europa)
  onClearCategory?: () => void;
  onClearContinent?: () => void;
  onOpen: (i: MediaItem) => void;
  onPlay: (i: MediaItem) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
  onAdd: () => void;
};

/** fereastră de numerotare: 1 … p-2 p-1 [p] p+1 p+2 … N */
function pageWindow(current: number, total: number): number[] {
  const out = new Set<number>([1, total]);
  for (let p = current - 2; p <= current + 2; p++) if (p >= 1 && p <= total) out.add(p);
  return [...out].sort((a, b) => a - b);
}

export function LibraryView({
  title, emoji, description, type, brand, brands, category, continent,
  onClearCategory, onClearContinent, onOpen, onPlay, isSaved, onToggleList, onAdd,
}: Props) {
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [sort, setSort] = useState("popularity");
  const [activeBrand, setActiveBrand] = useState(brand || "");
  const [loading, setLoading] = useState(true);

  useEffect(() => { setActiveBrand(brand || ""); setPage(1); }, [brand, type]);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), sort });
      if (type) qs.set("type", type);
      if (activeBrand) qs.set("brand", activeBrand);
      if (category) qs.set("category", category);
      if (continent) qs.set("continent", continent);
      const r = await api.browse<BrowseResp>(qs.toString());
      setItems(r.items || []);
      setTotal(r.total);
      setTotalPages(r.totalPages || 1);
      setPage(r.page);
    } catch {
      setItems([]);
      setTotal(0);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  }, [type, activeBrand, sort, category, continent]);

  useEffect(() => { load(1); }, [load]);

  const toMedia = (b: BrowseItem): MediaItem => ({
    id: `lib-${b.id}`,
    mediaType: b.contentType,
    title: b.title,
    poster: b.thumbnail,
    backdrop: b.backdrop,
    overview: b.description,
    year: b.year ? String(b.year) : "",
    rating: b.rating,
    source: `neon:${b.provider}`,
    sourceUrl: b.sourceUrl ?? null,
    embedCode: b.embedCode ?? null,
    neonId: b.id,
    signed: Boolean((b as { signed?: boolean }).signed),
  });

  const empty = !loading && items.length === 0;

  return (
    <div className="px-4 sm:px-6 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">{emoji} {title}</h1>
          <p className="mt-1 text-xs text-zinc-500">
            {description || "Conținut 100% din biblioteca ta Neon — adăugat prin URL / iframe / embed / JS."}
            {total > 0 && <b className="text-zinc-300"> • {total.toLocaleString("ro-RO")} conținuturi</b>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sort}
            onChange={(e) => { setSort(e.target.value); setPage(1); }}
            aria-label="Sortare"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200"
          >
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button
            onClick={onAdd}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-red-600 px-3 text-xs font-bold text-white hover:bg-red-500 transition"
          >
            <PlusCircle className="h-4 w-4" /> Adaugă
          </button>
        </div>
      </div>

      {/* FAZA 39 — chip filtru activ din submeniu (categorie / continent) */}
      {(category || continent) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {category && (
            <span className="flex items-center gap-1.5 rounded-full bg-red-600/15 px-3 py-1 text-xs font-bold text-red-300 ring-1 ring-red-600/40" data-filter-chip>
              categorie: {category}
              {onClearCategory && (
                <button onClick={onClearCategory} aria-label="Șterge filtrul de categorie" className="text-red-400 hover:text-red-200">✕</button>
              )}
            </span>
          )}
          {continent && (
            <span className="flex items-center gap-1.5 rounded-full bg-sky-600/15 px-3 py-1 text-xs font-bold text-sky-300 ring-1 ring-sky-600/40" data-filter-chip>
              continent: {continent}
              {onClearContinent && (
                <button onClick={onClearContinent} aria-label="Șterge filtrul de continent" className="text-sky-400 hover:text-sky-200">✕</button>
              )}
            </span>
          )}
        </div>
      )}

      {/* tab-uri brand (ex: Copii → Disney / Jetix / Fox Kids...) */}
      {brands && brands.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => { setActiveBrand(""); setPage(1); }}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              !activeBrand ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200 ring-1 ring-zinc-800"
            }`}
          >
            Toate
          </button>
          {brands.map(([b, label]) => (
            <button
              key={b}
              onClick={() => { setActiveBrand(b); setPage(1); }}
              className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
                activeBrand === b ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200 ring-1 ring-zinc-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* STARE GOALĂ — platforma așteaptă conținutul utilizatorului */}
      {empty && (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/60 px-6 py-16 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-600/15 ring-1 ring-red-600/30">
            <Database className="h-8 w-8 text-red-500" />
          </div>
          <h2 className="text-lg font-black text-zinc-100">Biblioteca {title} este goală</h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-zinc-500">
            Platforma nu mai conține niciun conținut pre-încărcat. Toate posterele de aici
            vor fi <b className="text-zinc-300">adăugate de tine</b> prin link direct
            (MP4/HLS/DASH), <b className="text-zinc-300">iframe</b>, <b className="text-zinc-300">cod embed</b> sau
            <b className="text-zinc-300"> JavaScript</b> din YouTube, OK.ru, Vimeo, TikTok,
            Dailymotion, Rumble sau orice altă sursă. Arhitectura susține
            <b className="text-red-500"> 30 miliarde</b> de conținuturi.
          </p>
          <button
            onClick={onAdd}
            className="mt-6 flex items-center gap-2 rounded-xl bg-red-600 px-6 py-3 text-sm font-bold text-white hover:bg-red-500 transition"
          >
            <PlusCircle className="h-5 w-5" /> Adaugă primul conținut
          </button>
        </div>
      )}

      {/* GRID — 20 postere/pagină */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-[2/3] animate-pulse rounded-xl bg-zinc-900" />
          ))}
        </div>
      ) : items.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {items.map((b) => {
              const m = toMedia(b);
              return (
                <div key={b.id} data-ai-click>
                  <MediaCard
                    item={m}
                    onOpen={onOpen}
                    onPlay={onPlay}
                    saved={isSaved(m, "watchlist")}
                    fav={isSaved(m, "favorites")}
                    onToggleList={(i) => onToggleList(i, "watchlist")}
                    width="w-full"
                  />
                </div>
              );
            })}
          </div>

          {/* PAGINARE AI — numerotată + next/prev */}
          {totalPages > 1 && (
            <div className="mt-8 flex flex-wrap items-center justify-center gap-1.5">
              <button
                onClick={() => load(page - 1)}
                disabled={!((page > 1))}
                className="flex h-9 items-center gap-1 rounded-lg bg-zinc-900 px-3 text-xs font-bold text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800 disabled:opacity-30 transition"
              >
                <ChevronLeft className="h-4 w-4" /> Precedenta
              </button>
              {pageWindow(page, totalPages).map((p, idx, arr) => (
                <span key={p} className="flex items-center">
                  {idx > 0 && p - arr[idx - 1] > 1 && <span className="px-1 text-zinc-600">…</span>}
                  <button
                    onClick={() => load(p)}
                    className={`h-9 min-w-9 rounded-lg px-2 text-xs font-bold transition ${
                      p === page ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800"
                    }`}
                  >
                    {p}
                  </button>
                </span>
              ))}
              <button
                onClick={() => load(page + 1)}
                disabled={!(page < totalPages)}
                className="flex h-9 items-center gap-1 rounded-lg bg-zinc-900 px-3 text-xs font-bold text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800 disabled:opacity-30 transition"
              >
                Următoarea <ChevronRight className="h-4 w-4" />
              </button>
              <span className="ml-2 flex items-center gap-1 text-[11px] text-zinc-600">
                <Layers className="h-3.5 w-3.5" /> {totalPages.toLocaleString("ro-RO")} pagini • 20/pag
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
