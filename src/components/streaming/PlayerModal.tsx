"use client";

import { useEffect, useRef, useState } from "react";
import { X, Pause, Play } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { MediaItem } from "./types";
import { api } from "./api";

type Props = {
  item: MediaItem | null;
  open: boolean;
  onClose: () => void;
  authed: boolean;
};

// Player YouTube — redă trailerul oficial / videoclipul muzical
export function PlayerModal({ item, open, onClose, authed }: Props) {
  const [trailerKey, setTrailerKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number>(0);
  const saveTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open || !item) return;
    setTrailerKey(null);
    setError(null);
    setElapsed(0);
    startedAt.current = Date.now();

    (async () => {
      // deja avem cheia (music/video)
      if (item.trailerKey) {
        setTrailerKey(item.trailerKey);
        return;
      }
      setLoading(true);
      try {
        if (item.source === "jikan") {
          const d = await api.anime<{ trailerKey?: string | null }>(`mode=details&id=${item.id}`);
          setTrailerKey(d.trailerKey || null);
          if (!d.trailerKey) throw new Error("no-trailer");
        } else {
          const d = await api.tmdb<{ trailerKey: string | null }>(
            `mode=details&type=${item.mediaType === "tv" || item.mediaType === "tv-maze" ? "tv" : "movie"}&id=${item.id}`
          );
          setTrailerKey(d.trailerKey || null);
          if (!d.trailerKey) throw new Error("no-trailer");
        }
      } catch {
        setError("Trailerul nu este disponibil pentru acest titlu. Încearcă titlul pe YouTube.");
      } finally {
        setLoading(false);
      }
    })();

    // salvează progresul la 5 secunde
    saveTimer.current = setInterval(() => {
      setElapsed((e) => e + 1);
    }, 1000);

    return () => {
      if (saveTimer.current) clearInterval(saveTimer.current);
    };
  }, [open, item]);

  // salvare progres la închidere
  useEffect(() => {
    return () => {
      if (!item) return;
      const secs = Math.round((Date.now() - startedAt.current) / 1000);
      if (secs < 5) return;
      const payload = {
        action: "progress",
        kind: "history",
        media: {
          mediaId: item.id, mediaType: item.mediaType, title: item.title,
          poster: item.poster, backdrop: item.backdrop, year: item.year,
          rating: item.rating, source: item.source || "tmdb",
        },
        progress: secs,
        duration: 0,
        trailerKey: item.trailerKey || null,
      };
      api.userPost(payload).catch(() => {});
    };
  }, [item]);

  if (!item) return null;

  const isMusic = item.mediaType === "music" || item.mediaType === "video";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-4xl bg-black border-zinc-800 p-0 gap-0 overflow-hidden">
        <div className="relative aspect-video w-full bg-black">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-red-600" />
            </div>
          )}

          {trailerKey && (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&rel=0${playing ? "" : "&pause=1"}`}
              title={item.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 h-full w-full"
            />
          )}

          {!loading && !trailerKey && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-zinc-400">{error || "Se caută trailerul..."}</p>
              <a
                href={`https://www.youtube.com/results?search_query=${encodeURIComponent(item.title + " trailer")}`}
                target="_blank"
                rel="noreferrer"
                className="rounded bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500"
              >
                Caută pe YouTube
              </a>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-zinc-100">{item.title}</p>
            <p className="text-xs text-zinc-500">
              {isMusic ? "Videoclip muzical" : "Trailer oficial"} • Timp vizionat: {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
              {!authed && " • Conectează-te pentru a salva progresul"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              aria-label={playing ? "Pauză" : "Redă"}
              onClick={() => setPlaying((p) => !p)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
            </button>
            <button
              aria-label="Închide"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-200 hover:bg-red-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
