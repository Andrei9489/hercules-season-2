"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink } from "lucide-react";
import type { NewsItem } from "./types";
import { api } from "./api";

const FEEDS = [
  { key: "bbc", label: "🌍 BBC World" },
  { key: "aljazeera", label: "🕌 Al Jazeera" },
  { key: "cnn", label: "🇺🇸 CNN" },
  { key: "nhk", label: "🇯🇵 NHK World" },
  { key: "entertainment", label: "✨ Show-biz" },
  { key: "tech", label: "💻 Tehnologie" },
  { key: "sport", label: "⚽ Sport" },
];

export function NewsView() {
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
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-4 text-2xl font-black tracking-tight">📰 Știri din întreaga lume</h1>

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
    </div>
  );
}
