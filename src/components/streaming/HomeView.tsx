"use client";

// ============================================================
// HomeView — Faza 8: PLATFORMĂ ALIMENTATĂ 100% DE UTILIZATOR
// ELIMINAT: toate rândurile cu conținut extern/simulat
// (TMDB trending/populare, anime airing, blockbustere TMDB).
// Home-ul afișează acum DOAR: studioul de încărcare universal,
// biblioteca Neon a utilizatorului, recomandările AI calculate
// pe conținutul real, istoricul propriu, panoul de capacitate
// (30 miliarde) și AI Hub-ul complet.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { MediaItem, UserItem, LibraryItem } from "./types";
import { api } from "./api";
import { Row } from "./Row";
import { MediaCard } from "./MediaCard";
import { CapacityPanel } from "./CapacityPanel";
import { LibraryAddDialog } from "./LibraryAddDialog";
import { AIHub } from "./AIHub";
import { PlayCircle, PlusCircle, Sparkles, UploadCloud, Globe2, Database } from "lucide-react";

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
  const [recs, setRecs] = useState<RecItem[]>([]);
  const [recMode, setRecMode] = useState("");
  const [history, setHistory] = useState<UserItem[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [addOpen, setAddOpen] = useState(false);

  const loadLibrary = useCallback(() => {
    api.library<{ items: LibraryItem[]; total: number }>("limit=18&facets=1")
      .then((r) => {
        setLibrary(r.items);
        setLibraryTotal(r.total);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  // AI RECOMANDĂRI — calculate DOAR pe conținutul real din Neon
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
    signed: Boolean((l as { signed?: boolean }).signed),
  });

  const playLibrary = (l: LibraryItem) => onPlay(libToMedia(l));
  const openLibraryDetail = (l: LibraryItem) => onOpen(libToMedia(l));

  return (
    <div className="pb-8">
      {/* ---------- STUDIO DE ÎNCĂRCARE UNIVERSAL (hero) ---------- */}
      <section className="px-4 pt-5 sm:px-6">
        <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950 p-6 sm:p-8">
          <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-red-600/10 blur-3xl" />
          <div className="relative">
            <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-red-600/15 px-3 py-1 text-[11px] font-bold text-red-400 ring-1 ring-red-600/30">
              <UploadCloud className="h-3.5 w-3.5" /> PLATFORMĂ ALIMENTATĂ DE TINE
            </div>
            <h1 className="max-w-2xl text-2xl font-black leading-tight tracking-tight sm:text-3xl">
              Încarcă orice conținut. Platforma susține{" "}
              <span className="text-red-500">30.000.000.000</span> de conținuturi.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-zinc-400">
              Adaugă tu conținutul prin <b className="text-zinc-200">link direct</b> (MP4 / HLS / DASH),
              <b className="text-zinc-200"> iframe</b>, <b className="text-zinc-200">cod embed</b> sau
              <b className="text-zinc-200"> JavaScript</b> din YouTube, OK.ru, Vimeo, TikTok, Dailymotion,
              Rumble, Twitch sau <b className="text-zinc-200">orice altă sursă</b> — inclusiv surse necunoscute.
              Playerul universal îl redă, motorul de căutare îl indexează instant în Neon, fără să pice nimic.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <button
                onClick={() => setAddOpen(true)}
                className="flex items-center gap-2 rounded-xl bg-red-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-red-500"
              >
                <PlusCircle className="h-5 w-5" /> Adaugă conținut acum
              </button>
              <div className="flex items-center gap-4 text-[11px] text-zinc-500">
                <span className="flex items-center gap-1"><Globe2 className="h-3.5 w-3.5 text-red-500" /> 196 țări</span>
                <span className="flex items-center gap-1"><Database className="h-3.5 w-3.5 text-red-500" /> 100% Neon, zero local</span>
                <span className="flex items-center gap-1"><Sparkles className="h-3.5 w-3.5 text-red-500" /> AI clasificare automată</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="relative z-10 space-y-7 pt-6">
        <CapacityPanel />

        {/* BIBLIOTECA UTILIZATORULUI */}
        <Row
          title={`🧠 Biblioteca ta Neon — redare universală (${libraryTotal.toLocaleString("ro-RO")})`}
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
          {library.length === 0 && (
            <div className="flex h-[176px] w-72 shrink-0 flex-col items-center justify-center rounded-xl bg-zinc-950/70 px-4 text-center ring-1 ring-zinc-800 sm:w-80">
              <p className="text-xs font-bold text-zinc-300">Biblioteca e pregătită — 0 conținuturi simulate</p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600">
                Fiecare poster de aici va fi unul încărcat de tine. Capacitatea totală:
                30 miliarde de conținuturi redate prin playerul universal.
              </p>
            </div>
          )}
          {library.map((l) => (
            <div key={`lib-${l.id}`} className="w-36 shrink-0 sm:w-40 lg:w-44" data-ai-click>
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
                {l.contentType} • {l.country || "Global"} • {l.sourceType}
              </p>
            </div>
          ))}
        </Row>

        {/* AI RECOMANDĂRI — din conținutul real al platformei */}
        {recs.length > 0 && (
          <Row title={`🤖 AI Recomandări${recMode === "personal" ? " pentru tine — din istoricul tău" : " — mix global calculat de AI"}`}>
            {recs.map((r) => {
              const m: MediaItem = {
                id: String(r.id), mediaType: "neon", title: r.title, poster: r.thumbnail,
                backdrop: r.backdrop, overview: r.description, year: r.year ? String(r.year) : "",
                rating: r.rating, source: "neon", neonId: r.id, signed: Boolean((r as { signed?: boolean }).signed),
              };
              return (
                <div key={`rec-${r.id}`} className="w-36 shrink-0 sm:w-40 lg:w-44" data-ai-click>
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

        {/* CONTINUĂ VIZIONAREA — istoric propriu */}
        {authed && history.length > 0 && (
          <Row title="▶ Continuă vizionarea" onMore={() => onNavigate("lista")}>
            {history.map((h) => (
              <div key={h.id} className="relative w-36 shrink-0 cursor-pointer group sm:w-40 lg:w-44" onClick={() => onOpen({
                id: h.mediaId, mediaType: h.mediaType, title: h.title, poster: h.poster,
                backdrop: h.backdrop, overview: "", year: h.year || "", rating: h.rating || 0, source: h.source || "neon",
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

        {/* AI HUB — analiză live + taxonomie AI + paginare infinită + metadate */}
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
