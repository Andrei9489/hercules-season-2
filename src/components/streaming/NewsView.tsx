"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ExternalLink, Play, Search, ShieldAlert, Tv } from "lucide-react";
import type { NewsItem } from "./types";
import { api } from "./api";
import { UniversalPlayer } from "./UniversalPlayer";
import { resolveSource } from "@/lib/source-resolver";
import { countryFlag, countryName } from "@/lib/countries";

const FEEDS = [
  { key: "bbc", label: "🌍 BBC World" },
  { key: "aljazeera", label: "🕌 Al Jazeera" },
  { key: "cnn", label: "🇺🇸 CNN" },
  { key: "nhk", label: "🇯🇵 NHK World" },
  { key: "entertainment", label: "✨ Show-biz" },
  { key: "tech", label: "💻 Tehnologie" },
  { key: "sport", label: "⚽ Sport" },
];

type Channel = {
  id: number;
  title: string;
  description: string;
  thumbnail: string | null;
  provider: string;
  sourceType: string;
  sourceUrl: string | null;
  country: string | null;
  continent: string | null;
  category: string | null;
  quality: string | null;
  geoBlocked: boolean;
  not247: boolean;
};

type ChannelsData = {
  ok: boolean;
  items: Channel[];
  total: number;
  filteredTotal: number;
  countries: { code: string; name: string; n: number }[];
  limit: number;
  offset: number;
};

const PAGE = 48;

export function NewsView({ initialContinent }: { initialContinent?: string }) {
  const [tab, setTab] = useState<"rss" | "live">("live");

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-3 text-2xl font-black tracking-tight">📰 Știri & TV Live</h1>

      <div className="mb-5 flex gap-2">
        <button
          onClick={() => setTab("live")}
          className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-bold transition ${
            tab === "live" ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800"
          }`}
        >
          <Tv className="h-4 w-4" /> Canale TV Live
        </button>
        <button
          onClick={() => setTab("rss")}
          className={`rounded-full px-4 py-2 text-xs font-bold transition ${
            tab === "rss" ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800"
          }`}
        >
          🗞️ Știri (RSS)
        </button>
      </div>

      {tab === "rss" ? <RssFeeds /> : <LiveTV initialContinent={initialContinent} />}
    </div>
  );
}

// ================= RSS (existente) =================
function RssFeeds() {
  const [feed, setFeed] = useState("bbc");
  const [data, setData] = useState<{ feed: string; items: NewsItem[] } | null>(null);
  const loading = !data || data.feed !== feed;

  useEffect(() => {
    let cancelled = false;
    api.news<NewsItem[]>(`feed=${feed}`)
      .then((items) => { if (!cancelled) setData({ feed, items }); })
      .catch(() => { if (!cancelled) setData({ feed, items: [] }); });
    return () => { cancelled = true; };
  }, [feed]);

  return (
    <>
      <div className="mb-5 flex flex-wrap gap-2">
        {FEEDS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFeed(f.key)}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              feed === f.key ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : data.items.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">Feed-ul nu este disponibil momentan.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.items.map((n) => (
            <a
              key={n.id}
              href={n.link}
              target="_blank"
              rel="noreferrer"
              className="group overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-zinc-800 transition hover:ring-red-600/60"
            >
              {n.image && (
                <img src={n.image} alt={n.title} loading="lazy" className="aspect-video w-full object-cover" />
              )}
              <div className="p-4">
                <p className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-red-400">
                  {n.source} <ExternalLink className="h-3 w-3" />
                </p>
                <p className="mb-2 line-clamp-2 text-sm font-bold text-zinc-100">{n.title}</p>
                <p className="line-clamp-3 text-xs leading-relaxed text-zinc-400">{n.description}</p>
                <p className="mt-2 text-[10px] text-zinc-600">{n.date}</p>
              </div>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

// ================= TV LIVE (Neon) =================
const CONTINENTS = ["Europa", "America de Nord", "America de Sud", "Asia", "Africa", "Oceania"];

function LiveTV({ initialContinent }: { initialContinent?: string }) {
  const [qText, setQText] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [country, setCountry] = useState("");
  const [continent, setContinent] = useState(
    CONTINENTS.includes(initialContinent || "") ? (initialContinent as string) : ""
  );
  const [data, setData] = useState<ChannelsData | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [items, setItems] = useState<Channel[]>([]);
  const [playing, setPlaying] = useState<Channel | null>(null);
  const reqSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(qText), 350);
    return () => clearTimeout(t);
  }, [qText]);

  const reqKey = `${qDebounced}|${country}|${continent}`;
  const loading = loadedKey !== reqKey;

  useEffect(() => {
    const seq = ++reqSeq.current;
    const qs = new URLSearchParams({ limit: String(PAGE), offset: "0" });
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
  }, [qDebounced, country, continent]);

  const loadMore = () => {
    if (!data) return;
    const offset = items.length;
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (qDebounced) qs.set("q", qDebounced);
    if (country) qs.set("country", country);
    if (continent) qs.set("continent", continent);
    api.channels<ChannelsData>(qs.toString())
      .then((d) => setItems((prev) => [...prev, ...d.items]))
      .catch(() => {});
  };

  const facets = data?.countries || [];
  const total = data ? (qDebounced || country || continent ? data.filteredTotal : data.total) : 0;

  return (
    <>
      <p className="mb-4 text-xs text-zinc-500">
        🛰️ <b className="text-zinc-300">{total}</b> {total === 1 ? "canal TV live de știri" : "canale TV live de știri"} din {facets.length || "—"} țări,
        indexate în <b className="text-zinc-300">Neon Cloud</b> și căutabile global. Sursă: playlist Popular News.
      </p>

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
            onClick={() => { setContinent(continent === c ? "" : c); }}
            className={`rounded-full px-3 py-1 text-[11px] font-bold transition ${
              continent === c ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <Input
            value={qText}
            onChange={(e) => setQText(e.target.value)}
            placeholder="Caută canal: BBC, Digi 24, Al Jazeera, Sky News…"
            className="border-zinc-800 bg-zinc-900 pl-9 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
        </div>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          aria-label="Filtrează după țară"
          className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-300"
        >
          <option value="">🌍 Toate țările</option>
          {facets.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} ({c.n})
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">Niciun canal găsit. Încearcă alt termen sau altă țară.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {items.map((ch) => (
              <ChannelCard key={ch.id} ch={ch} onPlay={() => setPlaying(ch)} />
            ))}
          </div>
          {items.length < total && (
            <div className="mt-6 text-center">
              <button
                onClick={loadMore}
                className="rounded-full bg-zinc-900 px-6 py-2 text-xs font-bold text-zinc-300 ring-1 ring-zinc-800 transition hover:bg-zinc-800"
              >
                Mai multe canale ({total - items.length} rămase)
              </button>
            </div>
          )}
        </>
      )}

      <ChannelPlayer channel={playing} onClose={() => setPlaying(null)} />
    </>
  );
}

function ChannelCard({ ch, onPlay }: { ch: Channel; onPlay: () => void }) {
  const playable = ch.sourceType === "hls" || ch.sourceType === "video" || ch.sourceType === "dash";
  return (
    <button
      onClick={() => playable && onPlay()}
      className={`group relative flex flex-col overflow-hidden rounded-xl bg-zinc-900 p-3 text-left ring-1 ring-zinc-800 transition ${
        playable ? "hover:ring-red-600/70 hover:bg-zinc-800/80" : "cursor-not-allowed opacity-60"
      }`}
    >
      <div className="mb-2 flex h-16 items-center justify-center">
        {ch.thumbnail ? (
          <img
            src={ch.thumbnail}
            alt={ch.title}
            loading="lazy"
            className="max-h-14 max-w-[85%] object-contain"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
          />
        ) : (
          <Tv className="h-8 w-8 text-zinc-700" />
        )}
      </div>
      <p className="line-clamp-2 min-h-[2.2rem] text-xs font-bold leading-snug text-zinc-100">{ch.title}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className="text-[10px] text-zinc-500">{countryFlag(ch.country)} {countryName(ch.country)}</span>
        {ch.quality && (
          <span className="rounded bg-zinc-800 px-1 text-[9px] font-bold text-zinc-400">{ch.quality}</span>
        )}
        {ch.geoBlocked && (
          <span className="rounded bg-amber-900/50 px-1 text-[9px] font-bold text-amber-400">GEO</span>
        )}
        {!playable && (
          <span className="rounded bg-zinc-800 px-1 text-[9px] font-bold text-zinc-500">{ch.sourceType.toUpperCase()}</span>
        )}
      </div>
      {playable && (
        <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-red-600/90 text-white opacity-0 transition group-hover:opacity-100">
          <Play className="h-3.5 w-3.5 fill-current" />
        </span>
      )}
    </button>
  );
}

function ChannelPlayer({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const source = useMemo(() => {
    if (!channel?.sourceUrl) return null;
    if (channel.sourceType === "hls" || channel.sourceType === "video" || channel.sourceType === "dash") {
      return resolveSource(channel.sourceUrl, { parent: typeof window !== "undefined" ? window.location.hostname : "" });
    }
    return null;
  }, [channel]);

  useEffect(() => {
    // eveniment de redare în Neon (views++ prin play_event)
    if (!channel) return;
    api.libraryPost({
      action: "play_event",
      contentId: channel.id,
      provider: channel.provider,
      event: "start",
      seconds: 0,
    }).catch(() => {});
  }, [channel]);

  if (!channel) return null;

  return (
    <Dialog open={!!channel} onOpenChange={(v) => !v && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-4xl bg-black border-zinc-800 p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">{channel.title}</DialogTitle>
        <div className="relative aspect-video w-full bg-black">
          {source ? (
            <div className="absolute inset-0">
              <UniversalPlayer source={source} title={channel.title} contentId={channel.id} />
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <ShieldAlert className="h-8 w-8 text-amber-400" />
              <p className="text-sm text-zinc-400">
                Acest canal folosește protocol <b>{channel.sourceType.toUpperCase()}</b> care nu poate fi redat direct în
                browser (SRT = stream profesional broadcast). Descarcă streamul și deschide-l într-un player extern (VLC, mpv).
              </p>
              {channel.sourceUrl && (
                <a
                  href={channel.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-500"
                >
                  Deschide streamul extern
                </a>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-zinc-100">
              {channel.title} <span className="ml-1 text-xs font-normal text-zinc-500">🔴 LIVE</span>
            </p>
            <p className="text-xs text-zinc-500">
              {countryFlag(channel.country)} {countryName(channel.country)} • {channel.category || "News"} •
              sursă: {channel.provider.toUpperCase()} din Neon
            </p>
          </div>
          <div className="flex items-center gap-2">
            {channel.sourceUrl && (
              <a
                href={channel.sourceUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Deschide extern"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            <button
              aria-label="Închide"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-200 hover:bg-red-600"
            >
              ✕
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
