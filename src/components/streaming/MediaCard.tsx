"use client";

import { Star, Play, Plus, Check, Heart } from "lucide-react";
import { motion } from "framer-motion";
import type { MediaItem } from "./types";

type Props = {
  item: MediaItem;
  onOpen: (item: MediaItem) => void;
  onPlay?: (item: MediaItem) => void;
  saved?: boolean;
  fav?: boolean;
  onToggleList?: (item: MediaItem) => void;
  width?: string;
};

export const MEDIA_TYPE_LABEL: Record<string, string> = {
  movie: "Film",
  tv: "Serial",
  anime: "Anime",
  music: "Muzică",
  video: "Video",
  "tv-maze": "Serial TV",
};

export function MediaCard({ item, onOpen, onPlay, saved, fav, onToggleList, width = "w-36 sm:w-40 lg:w-44" }: Props) {
  const label = MEDIA_TYPE_LABEL[item.mediaType] || "Conținut";
  return (
    <motion.div
      whileHover={{ scale: 1.04, y: -4 }}
      transition={{ type: "spring", stiffness: 300, damping: 22 }}
      data-ai-click
      className={`${width} shrink-0 group cursor-pointer`}
      onClick={() => onOpen(item)}
    >
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-zinc-800 ring-1 ring-white/10 shadow-lg shadow-black/40">
        {item.poster ? (
           
          <img
            src={item.poster}
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900 text-3xl">🎬</div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent opacity-90" />

        {/* rating chip */}
        {item.rating > 0 && (
          <div className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-amber-400 backdrop-blur">
            <Star className="h-3 w-3 fill-amber-400" /> {item.rating.toFixed(1)}
          </div>
        )}

        {/* action buttons on hover */}
        <div className="absolute inset-x-0 bottom-0 p-2 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            aria-label="Redare"
            onClick={(e) => { e.stopPropagation(); if (onPlay) onPlay(item); else onOpen(item); }}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-black hover:bg-red-600 hover:text-white transition-colors"
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
          <div className="flex gap-1">
            {onToggleList && (
              <button
                aria-label={saved ? "Elimină din listă" : "Adaugă în listă"}
                onClick={(e) => { e.stopPropagation(); onToggleList(item); }}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white ring-1 ring-white/30 hover:bg-white hover:text-black transition-colors"
              >
                {saved ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              </button>
            )}
          </div>
        </div>

        {fav && (
          <div className="absolute top-2 right-2 rounded-full bg-red-600/90 p-1">
            <Heart className="h-3 w-3 fill-white text-white" />
          </div>
        )}
      </div>

      <div className="mt-2 px-0.5">
        <p className="truncate text-[13px] font-medium text-zinc-100" title={item.title}>{item.title}</p>
        <p className="text-[11px] text-zinc-500">{label}{item.year ? ` • ${item.year}` : ""}</p>
      </div>
    </motion.div>
  );
}
