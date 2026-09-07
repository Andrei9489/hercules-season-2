"use client";

import { useEffect, useState } from "react";
import { Play, Info, Star } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { MediaItem } from "./types";

type Props = {
  items: MediaItem[];
  onPlay: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
};

export function Hero({ items, onPlay, onOpen }: Props) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), 7000);
    return () => clearInterval(t);
  }, [items.length]);

  if (!items.length) return null;
  const item = items[idx];
  const image = item.backdrop || item.poster;

  return (
    <div className="relative h-[62vh] min-h-[420px] max-h-[640px] w-full overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.div
          key={item.id}
          initial={{ opacity: 0, scale: 1.06 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
          className="absolute inset-0"
        >
          {image ? (
             
            <img src={image} alt={item.title} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-red-950 via-zinc-950 to-zinc-900" />
          )}
        </motion.div>
      </AnimatePresence>

      <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0f] via-[#0a0a0f]/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0f]/80 via-transparent to-transparent" />

      <motion.div
        key={`text-${item.id}`}
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.15 }}
        className="absolute bottom-16 sm:bottom-20 left-4 sm:left-6 max-w-xl"
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
            {item.mediaType === "tv" ? "Serial" : item.mediaType === "anime" ? "Anime" : "Film"}
          </span>
          {item.rating > 0 && (
            <span className="flex items-center gap-1 text-xs font-semibold text-amber-400">
              <Star className="h-3.5 w-3.5 fill-amber-400" /> {item.rating.toFixed(1)}
            </span>
          )}
          {item.year && <span className="text-xs text-zinc-400">{item.year}</span>}
        </div>
        <h1 className="text-2xl sm:text-4xl lg:text-5xl font-black tracking-tight text-white drop-shadow-lg">
          {item.title}
        </h1>
        {item.overview && (
          <p className="mt-3 hidden sm:block text-sm text-zinc-300 line-clamp-3 leading-relaxed drop-shadow">
            {item.overview}
          </p>
        )}
        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={() => onPlay(item)}
            className="flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-bold text-black transition hover:bg-red-600 hover:text-white"
          >
            <Play className="h-4 w-4 fill-current" /> Redă trailer
          </button>
          <button
            onClick={() => onOpen(item)}
            className="flex items-center gap-2 rounded-lg bg-zinc-700/70 px-5 py-2.5 text-sm font-bold text-white backdrop-blur transition hover:bg-zinc-600"
          >
            <Info className="h-4 w-4" /> Detalii
          </button>
        </div>
      </motion.div>

      <div className="absolute bottom-5 left-4 sm:left-6 flex gap-1.5">
        {items.map((_, i) => (
          <button
            key={i}
            aria-label={`Slide ${i + 1}`}
            onClick={() => setIdx(i)}
            className={`h-1.5 rounded-full transition-all ${i === idx ? "w-6 bg-red-600" : "w-2 bg-zinc-600 hover:bg-zinc-500"}`}
          />
        ))}
      </div>
    </div>
  );
}
