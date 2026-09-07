"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { GameItem, SportEvent } from "./types";
import { api } from "./api";

type DotaData = { heroes: GameItem[]; matches: SportEvent[] };

export function GamingView() {
  const [tab, setTab] = useState<"pokemon" | "dota" | "steam" | "minecraft">("pokemon");
  const [games, setGames] = useState<GameItem[]>([]);
  const [dota, setDota] = useState<DotaData>({ heroes: [], matches: [] });
  const [mcStatus, setMcStatus] = useState<{ server: string; online: boolean; players: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        if (tab === "dota") {
          const d = await api.gaming<DotaData>("mode=dota");
          setDota(d); setGames([]);
        } else if (tab === "minecraft") {
          const s = await api.gaming<{ server: string; online: boolean; players: number }[]>("mode=minecraft");
          setMcStatus(s[0] || null); setGames([]);
        } else {
          const g = await api.gaming<GameItem[]>(`mode=${tab}`);
          setGames(g);
        }
      } catch {
        setGames([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [tab]);

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-4 text-2xl font-black tracking-tight">🎮 Gaming</h1>

      <div className="mb-5 flex flex-wrap gap-2">
        {([
          { k: "pokemon", l: "⚡ Pokémon" },
          { k: "dota", l: "🛡️ Dota 2" },
          { k: "steam", l: "💨 Steam" },
          { k: "minecraft", l: "🧱 Minecraft" },
        ] as { k: typeof tab; l: string }[]).map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              tab === t.k ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {t.l}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
        </div>
      ) : (
        <>
          {tab === "minecraft" && mcStatus && (
            <div className="mx-auto max-w-md rounded-2xl bg-zinc-900 p-6 text-center ring-1 ring-zinc-800">
              <div className={`mx-auto mb-3 h-4 w-4 rounded-full ${mcStatus.online ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
              <p className="text-lg font-black">{mcStatus.server}</p>
              <p className="text-sm text-zinc-400">
                {mcStatus.online ? `Online — ${mcStatus.players.toLocaleString("ro-RO")} jucători` : "Server offline"}
              </p>
            </div>
          )}

          {tab === "dota" && (
            <div className="space-y-8">
              {dota.matches.length > 0 && (
                <section>
                  <h2 className="mb-3 text-base font-bold">🏁 Meciuri profesionale recente</h2>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {dota.matches.map((m) => (
                      <div key={m.id} className="rounded-xl bg-zinc-900/70 p-4 ring-1 ring-zinc-800">
                        <p className="mb-1 truncate text-[11px] font-bold uppercase text-red-400">{m.competition}</p>
                        <div className="flex items-center justify-between text-sm font-semibold">
                          <span className="truncate">{m.home}</span>
                          <span className="mx-2 shrink-0 rounded bg-zinc-800 px-2 py-0.5 text-xs">{m.score}</span>
                          <span className="truncate text-right">{m.away}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {dota.heroes.length > 0 && (
                <section>
                  <h2 className="mb-3 text-base font-bold">🛡️ Eroul tău</h2>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                    {dota.heroes.map((h) => (
                      <div key={h.id} className="group overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-zinc-800 hover:ring-red-600/50 transition">
                        {h.image && (
                           
                          <img src={h.image} alt={h.name} loading="lazy" className="aspect-video w-full object-cover" />
                        )}
                        <div className="p-2">
                          <p className="truncate text-xs font-bold">{h.name}</p>
                          <p className="truncate text-[10px] text-zinc-500">{h.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {games.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {games.map((g) => (
                <div key={g.id} className="group overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-zinc-800 hover:ring-red-600/50 transition">
                  <div className="relative aspect-[3/4] overflow-hidden bg-zinc-800">
                    {g.image ? (
                       
                      <img src={g.image} alt={g.name} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-3xl">🎮</div>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="truncate text-[13px] font-bold" title={g.name}>{g.name}</p>
                    <p className="truncate text-[11px] capitalize text-zinc-500">{g.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
