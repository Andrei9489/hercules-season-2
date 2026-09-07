"use client";

import { useEffect, useRef, useState } from "react";
import { Search, Play, Radio as RadioIcon, Loader2, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "./api";
import { countryFlag, countryName } from "@/lib/countries";

// ============================================================
// RadioView — RADIO LIVE GLOBAL (Faza 6)
// Posturi reale din Neon (radio-browser, ingest industrial).
// Grid cu favicon/steag/țară/bitrate/codec, filtre continente +
// țară (facet), căutare cu debounce. Redare prin UniversalPlayer
// (MP3/AAC/OGG direct + HLS prin hls.js).
// ============================================================

type RadioRow = {
  id: number;
  title: string;
  description: string;
  thumbnail: string | null;
  sourceType: string;
  sourceUrl: string | null;
  country: string | null;
  continent: string | null;
  category: string | null;
  quality: string | null;
  codec: string | null;
  bitrate: number | null;
};

type ChannelsData = {
  ok: boolean;
  items: RadioRow[];
  total: number;
  filteredTotal: number;
  countries: { code: string; name: string; n: number }[];
  limit: number;
  offset: number;
};

const PAGE = 60;
const CONTINENTS = ["Europa", "America de Nord", "America de Sud", "Asia", "Africa", "Oceania"];

export function RadioView() {
  const [qText, setQText] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [country, setCountry] = useState("");
  const [continent, setContinent] = useState("");
  const [items, setItems] = useState<RadioRow[]>([]);
  const [data, setData] = useState<ChannelsData | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const reqSeq = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(qText), 350);
    return () => clearTimeout(t);
  }, [qText]);

  const reqKey = `${qDebounced}|${country}|${continent}`;
  const loading = loadedKey !== reqKey;

  useEffect(() => {
    const seq = ++reqSeq.current;
    const qs = new URLSearchParams({ type: "radio", limit: String(PAGE), offset: "0" });
    if (qDebounced) qs.set("q", qDebounced);
    if (country) qs.set("country", country);
    if (continent) qs.set("continent", continent);
    api.channels<ChannelsData>(qs.toString())
      .then((d) => {
        if (seq !== reqSeq.current) return;
        setData(d);
        setItems(d.items);
        setLoadedKey(reqKey);
      })
      .catch(() => {
        if (seq !== reqSeq.current) return;
        setData(null);
        setItems([]);
        setLoadedKey(reqKey);
      });
  }, [reqKey]);

  const loadMore = () => {
    setLoadingMore(true);
    const qs = new URLSearchParams({ type: "radio", limit: String(PAGE), offset: String(items.length) });
    if (qDebounced) qs.set("q", qDebounced);
    if (country) qs.set("country", country);
    if (continent) qs.set("continent", continent);
    api.channels<ChannelsData>(qs.toString())
      .then((d) => setItems((prev) => [...prev, ...d.items]))
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  const facets = data?.countries || [];
  const total = data ? (qDebounced || country || continent ? data.filteredTotal : data.total) : 0;

  const play = (r: RadioRow) => {
    if (!r.sourceUrl) return;

    // toggle stop
    if (playingId === r.id) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingId(null);
      return;
    }

    // pornire nouă — oprim orice altă postare activă
    audioRef.current?.pause();
    const a = new Audio(r.sourceUrl);
    a.volume = 0.9;
    a.onended = () => setPlayingId(null);
    a.onerror = () => {
      setPlayingId(null);
      // fallback: player extern (folosit doar pentru HLS/erori de codecuri)
      if (r.sourceType === "hls") window.open(r.sourceUrl as string, "_blank");
    };
    audioRef.current = a;
    setPlayingId(r.id);
    a.play().catch(() => {
      setPlayingId(null);
      window.open(r.sourceUrl as string, "_blank");
    });

    // eveniment de redare în Neon (views++ prin play_event)
    void fetch("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "play_event",
        contentId: r.id,
        provider: "radio-browser",
        event: "start",
        seconds: 0,
      }),
    }).catch(() => {});
  };

  return (
    <div className="px-4 py-6 sm:px-6">
      <h1 className="mb-2 text-2xl font-black tracking-tight">📻 Radio Live</h1>
      <p className="mb-4 text-xs text-zinc-500">
        🛰️ <b className="text-zinc-300">{total}</b> posturi radio live din {facets.length || "—"} țări,
        indexate în <b className="text-zinc-300">Neon Cloud</b>. Sursă: directorul global radio-browser
        (top clickcount, doar streamuri https reproductibile — MP3/AAC/OGG + HLS).
      </p>

      {/* filtre continente */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10px] font-bold uppercase tracking-widest text-zinc-600">🌍 Lumea</span>
        <button
          onClick={() => { setContinent(""); setCountry(""); }}
          className={`rounded-full px-3 py-1 text-[11px] font-bold transition ${
            !continent ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800"
          }`}
        >
          Toate
        </button>
        {CONTINENTS.map((c) => (
          <button
            key={c}
            onClick={() => { setContinent(continent === c ? "" : c); setCountry(""); }}
            className={`rounded-full px-3 py-1 text-[11px] font-bold transition ${
              continent === c ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {/* căutare + țară */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <Input
            value={qText}
            onChange={(e) => setQText(e.target.value)}
            placeholder="Caută post: Kiss FM, Radio ZU, BBC Radio 1, NRJ, Europa FM…"
            className="border-zinc-800 bg-zinc-900 pl-9 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
        </div>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          aria-label="Filtrează după țară"
        >
          <option value="">Toate țările ({facets.length})</option>
          {facets.map((c) => (
            <option key={c.code} value={c.code}>
              {countryFlag(c.code)} {c.name} ({c.n})
            </option>
          ))}
        </select>
      </div>

      {/* grid posturi */}
      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((r) => {
              const isPlaying = playingId === r.id;
              return (
                <div
                  key={r.id}
                  className={`flex items-center gap-3 rounded-xl p-3 ring-1 transition ${
                    isPlaying ? "bg-red-950/40 ring-red-600/60" : "bg-zinc-900/70 ring-zinc-800 hover:bg-zinc-900"
                  }`}
                >
                  <div className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-800">
                    {r.thumbnail ? (
                      <img src={r.thumbnail} alt={r.title} loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <RadioIcon className="h-5 w-5 text-zinc-500" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-zinc-100" title={r.title}>{r.title}</p>
                    <p className="truncate text-[11px] text-zinc-500">
                      {countryFlag(r.country)} {countryName(r.country)}
                      {r.bitrate ? ` • ${r.bitrate}kbps` : ""}
                      {r.codec ? ` • ${r.codec}` : ""}
                      {r.sourceType === "hls" ? " • HLS" : ""}
                    </p>
                    {r.category ? (
                      <p className="truncate text-[10px] text-zinc-600">{r.category}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => play(r)}
                      aria-label={`${isPlaying ? "Oprește" : "Redă"} ${r.title}`}
                      className={`flex h-9 w-9 items-center justify-center rounded-full transition ${
                        isPlaying ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-200 hover:bg-red-600 hover:text-white"
                      }`}
                    >
                      {isPlaying ? <span className="text-xs font-black">■</span> : <Play className="h-4 w-4 fill-current" />}
                    </button>
                    {r.sourceType === "hls" && r.sourceUrl ? (
                      <a
                        href={r.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Player extern pentru ${r.title}`}
                        className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800/60 text-zinc-500 hover:text-zinc-200"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {items.length < total && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="outline"
                onClick={loadMore}
                disabled={loadingMore}
                className="border-zinc-700 text-zinc-200 hover:bg-zinc-800"
              >
                {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Mai multe ({items.length}/{total})
              </Button>
            </div>
          )}

          {!items.length && (
            <p className="py-16 text-center text-sm text-zinc-500">
              Nicio postare radio găsită{qDebounced ? ` pentru „${qDebounced}"` : ""}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
