"use client";

import { useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Props = {
  title: string;
  children: ReactNode;
  onMore?: () => void;
};

export function Row({ title, children, onMore }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const scroll = (dir: 1 | -1) => {
    ref.current?.scrollBy({ left: dir * (ref.current.clientWidth * 0.8), behavior: "smooth" });
  };

  return (
    <section className="group/row relative">
      <div className="mb-3 flex items-center justify-between px-4 sm:px-6">
        <h2 className="text-base sm:text-lg font-bold tracking-tight text-zinc-100">{title}</h2>
        <div className="flex items-center gap-1">
          {onMore && (
            <button
              onClick={onMore}
              className="text-xs text-red-400 hover:text-red-300 font-medium"
            >
              Vezi toate →
            </button>
          )}
          <div className="hidden sm:flex opacity-0 group-hover/row:opacity-100 transition-opacity">
            <button
              aria-label="Derulează stânga"
              onClick={() => scroll(-1)}
              className="h-8 w-8 flex items-center justify-center rounded-full bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              aria-label="Derulează dreapta"
              onClick={() => scroll(1)}
              className="h-8 w-8 flex items-center justify-center rounded-full bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      <div
        ref={ref}
        className="flex gap-3 overflow-x-auto px-4 sm:px-6 pb-2 scrollbar-thin scrollbar-thumb-zinc-700"
        style={{ scrollbarWidth: "thin" }}
      >
        {children}
      </div>
    </section>
  );
}
