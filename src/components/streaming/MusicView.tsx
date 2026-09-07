"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Play, Music2, FileText, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import type { MusicData } from "./types";
import { api } from "./api";

type Song = MusicData["songs"][number];
type Video = MusicData["videos"][number];

const QUICK = ["Top hits 2026", "Romanian music", "Rock classics", "Hip hop", "Manele", "Jazz", "Electro dance", "K-pop", "Latin hits", "Anime music"];

export function MusicView() {
  const [q, setQ] = useState("Top hits 2026");
  const [data, setData] = useState<MusicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<string | null>(null);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [lyrics, setLyrics] = useState<{ song: Song; text: string } | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);

  const fetchMusic = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const d = await api.music<MusicData>(`mode=search&q=${encodeURIComponent(query)}`);
      setData(d);
    } catch {
      setData({ songs: [], videos: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMusic("Top hits 2026"); }, [fetchMusic]);

  const playPreview = (s: Song) => {
    if (playing === s.id) {
      audio?.pause(); setPlaying(null); setAudio(null);
      return;
    }
    audio?.pause();
    if (!s.preview) {
      if (s.youtubeKey) {
        window.open(`https://www.youtube.com/watch?v=${s.youtubeKey}`, "_blank");
        return;
      }
      toast({ title: "Previzualizare indisponibilă", description: `${s.title} — ${s.artist}` });
      return;
    }
    const a = new Audio(s.preview);
    a.volume = 0.8;
    a.play().catch(() => toast({ title: "Eroare redare", variant: "destructive" }));
    a.onended = () => { setPlaying(null); setAudio(null); };
    setAudio(a);
    setPlaying(s.id);
  };

  const loadLyrics = async (s: Song) => {
    setLyricsLoading(true);
    try {
      const d = await api.music<{ lyrics: string | null }>(`mode=lyrics&artist=${encodeURIComponent(s.artist)}&track=${encodeURIComponent(s.title)}`);
      if (d.lyrics) setLyrics({ song: s, text: d.lyrics });
      else toast({ title: "Versuri indisponibile", description: `${s.title} — ${s.artist}` });
    } catch {
      toast({ title: "Versuri indisponibile", variant: "destructive" });
    } finally {
      setLyricsLoading(false);
    }
  };

  const playVideo = (v: Video) => {
    if (v.youtubeKey) window.open(`https://www.youtube.com/watch?v=${v.youtubeKey}`, "_blank");
  };

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-4 text-2xl font-black tracking-tight">🎵 Muzică</h1>

      <form
        onSubmit={(e) => { e.preventDefault(); if (q.trim()) fetchMusic(q.trim()); }}
        className="mb-4 flex gap-2"
      >
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Caută melodii, artiști, albume..."
            className="pl-8 border-zinc-800 bg-zinc-900 text-sm text-zinc-200 placeholder:text-zinc-500"
          />
        </div>
        <Button type="submit" className="bg-red-600 hover:bg-red-500 text-white">Caută</Button>
      </form>

      <div className="mb-6 flex flex-wrap gap-1.5">
        {QUICK.map((s) => (
          <button
            key={s}
            onClick={() => { setQ(s); fetchMusic(s); }}
            className="rounded-full bg-zinc-900 px-3 py-1 text-[11px] font-semibold text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200 hover:bg-zinc-800"
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-52 rounded-xl" />)}
        </div>
      ) : (
        <>
          {data?.songs?.length ? (
            <section className="mb-8">
              <h2 className="mb-3 text-base font-bold text-zinc-100">🎧 Piese & albume</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
                {data.songs.slice(0, 24).map((s) => (
                  <div key={s.id} className="group rounded-xl bg-zinc-900/70 p-3 ring-1 ring-zinc-800 hover:bg-zinc-900 transition">
                    <div className="relative mb-2 aspect-square overflow-hidden rounded-lg bg-zinc-800">
                      {s.artwork ? (
                         
                        <img src={s.artwork} alt={s.title} loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-3xl"><Music2 /></div>
                      )}
                      <button
                        onClick={() => playPreview(s)}
                        aria-label={`Redă ${s.title}`}
                        className={`absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition-all ${
                          playing === s.id ? "bg-red-600 text-white opacity-100" : "bg-white text-black opacity-0 group-hover:opacity-100"
                        }`}
                      >
                        {playing === s.id ? "⏸" : <Play className="h-4 w-4 fill-current" />}
                      </button>
                    </div>
                    <p className="truncate text-[13px] font-semibold text-zinc-100" title={s.title}>{s.title}</p>
                    <p className="truncate text-[11px] text-zinc-500">{s.artist}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] uppercase text-zinc-600">{s.genre || s.source}</span>
                      <button
                        onClick={() => loadLyrics(s)}
                        aria-label={`Versuri ${s.title}`}
                        className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-red-400"
                      >
                        {lyricsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />} Versuri
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {data?.videos?.length ? (
            <section>
              <h2 className="mb-3 text-base font-bold text-zinc-100">📹 Videoclipuri</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {data.videos.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => playVideo(v)}
                    className="group overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-zinc-800 text-left hover:ring-red-600/60 transition"
                  >
                    <div className="relative aspect-video overflow-hidden bg-zinc-800">
                      {v.artwork ? (
                         
                        <img src={v.artwork} alt={v.title} loading="lazy" className="h-full w-full object-cover group-hover:scale-105 transition-transform" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-3xl"><Music2 /></div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Play className="h-12 w-12 fill-white text-white drop-shadow" />
                      </div>
                    </div>
                    <div className="p-3">
                      <p className="truncate text-sm font-semibold text-zinc-100">{v.title}</p>
                      <p className="truncate text-xs text-zinc-500">{v.artist}</p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {!data?.songs?.length && !data?.videos?.length && (
            <p className="py-16 text-center text-sm text-zinc-500">Niciun rezultat pentru „{q}".</p>
          )}
        </>
      )}

      {/* versuri overlay */}
      {lyrics && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur"
          onClick={() => setLyrics(null)}
        >
          <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-zinc-950 p-6 ring-1 ring-zinc-800" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 text-lg font-black">{lyrics.song.title}</h3>
            <p className="mb-4 text-sm text-zinc-500">{lyrics.song.artist}</p>
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-300">{lyrics.text}</pre>
            <Button variant="outline" onClick={() => setLyrics(null)} className="mt-5 border-zinc-700 text-zinc-200">
              Închide
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
