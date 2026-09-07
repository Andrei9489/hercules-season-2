"use client";

import { useEffect, useState } from "react";
import { X, Play, Plus, Check, Star, Subtitles, Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import type { MediaItem, DetailData } from "./types";
import { api } from "./api";
import { MEDIA_TYPE_LABEL } from "./MediaCard";

type SubtitleRow = { id: string; release: string; fileName: string; downloads: number };

type Props = {
  item: MediaItem | null;
  open: boolean;
  onClose: () => void;
  onPlay: (item: MediaItem) => void;
  onOpenItem: (item: MediaItem) => void;
  isSaved: (item: MediaItem, kind: "watchlist" | "favorites") => boolean;
  onToggleList: (item: MediaItem, kind: "watchlist" | "favorites") => void;
  authed: boolean;
};

export function DetailModal({ item, open, onClose, onPlay, onOpenItem, isSaved, onToggleList, authed }: Props) {
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [subs, setSubs] = useState<SubtitleRow[] | null>(null);
  const [subsLoading, setSubsLoading] = useState(false);
  const [rating, setRating] = useState<number>(0);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open || !item) return;
    setDetail(null);
    setSubs(null);
    setRating(0);
    setComment("");
    setLoading(true);
    (async () => {
      try {
        if (item.source === "neon" || (item as { sourceUrl?: string | null }).sourceUrl) {
          // item din biblioteca Neon — metadatele sunt deja în item
          setDetail({ ...item, trailerKey: null });
        } else if (item.source === "jikan" && item.mediaType === "anime") {
          const d = await api.anime<DetailData>(`mode=details&id=${item.id}`);
          setDetail(d);
        } else if (item.source === "tvmaze" || item.mediaType === "tv-maze") {
          const d = await api.tv<DetailData>(`mode=details&id=${item.id}`);
          setDetail({ ...d, trailerKey: null });
        } else if (item.mediaType === "music" || item.mediaType === "video") {
          setDetail({ ...item, trailerKey: item.trailerKey || null });
        } else {
          const d = await api.tmdb<DetailData>(`mode=details&type=${item.mediaType}&id=${item.id}`);
          setDetail(d);
        }
      } catch {
        setDetail({ ...item, trailerKey: item.trailerKey || null });
      } finally {
        setLoading(false);
      }
    })();
  }, [open, item]);

  const loadSubs = async () => {
    if (!item) return;
    setSubsLoading(true);
    try {
      const isTmdb = item.source === "tmdb";
      const rows = await api.subtitles<SubtitleRow[]>(
        isTmdb ? `tmdbId=${item.id}&lang=ro` : `query=${encodeURIComponent(item.title)}&lang=ro`
      );
      setSubs(rows);
    } catch {
      setSubs([]);
      toast({ title: "Subtitrări", description: "Nicio subtitrare disponibilă momentan." });
    } finally {
      setSubsLoading(false);
    }
  };

  const sendReview = async () => {
    if (!authed) {
      toast({ title: "Autentificare necesară", description: "Conectează-te pentru a evalua conținutul." });
      return;
    }
    if (!item || !rating) return;
    setSending(true);
    try {
      await api.userPost({
        action: "add", kind: "reviews",
        media: { mediaId: item.id, mediaType: item.mediaType, title: item.title, poster: item.poster, source: item.source },
        rating, comment,
      });
      toast({ title: "Mulțumim!", description: "Evaluarea ta a fost salvată." });
    } catch {
      toast({ title: "Eroare", description: "Nu am putut salva evaluarea.", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const d = detail || item;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-3xl max-h-[88vh] overflow-y-auto bg-zinc-950 border-zinc-800 text-zinc-100 p-0 gap-0">
        {d?.backdrop || d?.poster ? (
          <div className="relative h-52 sm:h-64 w-full overflow-hidden rounded-t-lg">
            { }
            <img src={d.backdrop || d.poster || ""} alt={d.title} className="h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent" />
            <DialogHeader className="absolute bottom-3 left-5 right-5 items-start">
              <DialogTitle className="text-xl sm:text-2xl font-black text-white drop-shadow">{d.title}</DialogTitle>
            </DialogHeader>
          </div>
        ) : (
          <DialogHeader className="p-5 pb-0">
            <DialogTitle className="text-xl font-black">{d?.title || "Se încarcă..."}</DialogTitle>
          </DialogHeader>
        )}

        <div className="p-5 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-red-600" />
            </div>
          )}

          {!loading && d && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {d.rating > 0 && (
                  <span className="flex items-center gap-1 rounded bg-amber-950/60 px-2 py-1 font-semibold text-amber-400">
                    <Star className="h-3 w-3 fill-amber-400" /> {Number(d.rating).toFixed(1)}
                  </span>
                )}
                <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">
                  {MEDIA_TYPE_LABEL[d.mediaType] || d.mediaType}
                </span>
                {d.year && <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">{d.year}</span>}
                {d.episodes != null && d.episodes > 0 && (
                  <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">{d.episodes} episoade</span>
                )}
                {d.status && <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">{d.status}</span>}
                {d.genres?.map((g) => (
                  <span key={g} className="rounded bg-red-950/70 px-2 py-1 text-red-300">{g}</span>
                ))}
              </div>

              <p className="text-sm leading-relaxed text-zinc-300">
                {d.overview || "Descriere indisponibilă."}
              </p>

              <div className="flex flex-wrap gap-2">
                {(() => {
                  const hasDirect = Boolean(
                    (d as { sourceUrl?: string | null }).sourceUrl || (d as { embedCode?: string | null }).embedCode
                  );
                  const playable = hasDirect || d.trailerKey || d.mediaType === "music" || d.mediaType === "video";
                  return (
                    <Button
                      onClick={() => onPlay(item!)}
                      className="bg-red-600 hover:bg-red-500 text-white font-bold"
                      disabled={!playable}
                    >
                      <Play className="h-4 w-4 mr-1 fill-current" />
                      {hasDirect ? "Redă acum" : d.trailerKey || d.mediaType === "music" || d.mediaType === "video" ? "Redă" : "Trailer indisponibil"}
                    </Button>
                  );
                })()}

                <Button
                  variant="outline"
                  onClick={() => onToggleList(item!, "watchlist")}
                  className="border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
                >
                  {isSaved(item!, "watchlist") ? <Check className="h-4 w-4 mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
                  {isSaved(item!, "watchlist") ? "În listă" : "Lista mea"}
                </Button>

                <Button
                  variant="outline"
                  onClick={() => onToggleList(item!, "favorites")}
                  className="border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
                >
                  <Star className={`h-4 w-4 mr-1 ${isSaved(item!, "favorites") ? "fill-amber-400 text-amber-400" : ""}`} />
                  {isSaved(item!, "favorites") ? "Favorit" : "Favorit"}
                </Button>

                {d.source === "tmdb" && (
                  <Button
                    variant="outline"
                    onClick={loadSubs}
                    className="border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
                  >
                    {subsLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Subtitles className="h-4 w-4 mr-1" />}
                    Subtitrări RO
                  </Button>
                )}
              </div>

              {subs && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-400">Subtitrări în română</p>
                  {subs.length === 0 ? (
                    <p className="text-sm text-zinc-500">Nu s-au găsit subtitrări.</p>
                  ) : (
                    <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                      {subs.map((s) => (
                        <li key={s.id} className="flex items-center justify-between rounded bg-zinc-900 px-2 py-1.5">
                          <span className="truncate text-zinc-300">{s.release || s.fileName}</span>
                          <span className="ml-2 shrink-0 text-xs text-zinc-500">{s.downloads} descărcări</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-[11px] text-zinc-600">Sursă: OpenSubtitles — redarea fișierelor externe nu este inclusă în demo.</p>
                </div>
              )}

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
                <p className="mb-2 text-sm font-bold">Evaluează conținutul</p>
                <div className="mb-3 flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      aria-label={`${n} stele`}
                      onClick={() => setRating(n)}
                      className="transition-transform hover:scale-110"
                    >
                      <Star className={`h-6 w-6 ${n <= rating ? "fill-amber-400 text-amber-400" : "text-zinc-600"}`} />
                    </button>
                  ))}
                </div>
                <Textarea
                  placeholder="Scrie un scurt review (opțional)..."
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  className="mb-2 min-h-[60px] border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
                />
                <Button
                  size="sm"
                  onClick={sendReview}
                  disabled={!rating || sending}
                  className="bg-red-600 hover:bg-red-500 text-white"
                >
                  {sending ? "Se trimite..." : "Trimite evaluarea"}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
