"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, CalendarDays } from "lucide-react";
import type { SportEvent, Standing } from "./types";
import { api } from "./api";

type Tab = "football" | "nba" | "f1" | "openliga" | "standings";

const FOOTBALL_COMPS = [
  { id: "PL", label: "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League" },
  { id: "PD", label: "🇪🇸 La Liga" },
  { id: "SA", label: "🇮🇹 Serie A" },
  { id: "BL1", label: "🇩🇪 Bundesliga" },
  { id: "FL1", label: "🇫🇷 Ligue 1" },
  { id: "CL", label: "🏆 Champions League" },
];

function fmtDate(d: string): string {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleString("ro-RO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function SportsView() {
  const [tab, setTab] = useState<Tab>("football");
  const [comp, setComp] = useState("PL");
  const [status, setStatus] = useState<"SCHEDULED" | "FINISHED">("SCHEDULED");
  const [events, setEvents] = useState<SportEvent[]>([]);
  const [standings, setStandings] = useState<Standing[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "standings") {
        const s = await api.sports<Standing[]>(`mode=standings&competition=${comp}`);
        setStandings(s);
        setEvents([]);
      } else {
        const qs =
          tab === "football" ? `mode=football&competition=${comp}&status=${status}`
          : tab === "nba" ? "mode=nba"
          : tab === "f1" ? "mode=f1"
          : "mode=openliga";
        const e = await api.sports<SportEvent[]>(qs);
        setEvents(e);
        setStandings([]);
      }
    } catch {
      setEvents([]); setStandings([]);
    } finally {
      setLoading(false);
    }
  }, [tab, comp, status]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-4 text-2xl font-black tracking-tight">🏟️ Sport</h1>

      <div className="mb-4 flex flex-wrap gap-2">
        {([
          { k: "football", l: "⚽ Fotbal" },
          { k: "standings", l: "📊 Clasamente" },
          { k: "nba", l: "🏀 NBA" },
          { k: "f1", l: "🏎️ Formula 1" },
          { k: "openliga", l: "🇩🇪 Bundesliga (OpenLiga)" },
        ] as { k: Tab; l: string }[]).map((t) => (
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

      {(tab === "football" || tab === "standings") && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          {FOOTBALL_COMPS.map((c) => (
            <button
              key={c.id}
              onClick={() => { setComp(c.id); if (tab !== "standings") setTab("standings"); }}
              className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
                comp === c.id ? "bg-white text-black" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {tab === "football" && (
        <div className="mb-5 flex gap-2">
          {([
            { k: "SCHEDULED", l: "Programate" },
            { k: "FINISHED", l: "Finalizate" },
          ] as const).map((s) => (
            <button
              key={s.k}
              onClick={() => setStatus(s.k)}
              className={`rounded-full px-3 py-1 text-[11px] font-semibold transition ${
                status === s.k ? "bg-white text-black" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200"
              }`}
            >
              {s.l}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      ) : standings.length > 0 ? (
        <div className="overflow-x-auto rounded-xl ring-1 ring-zinc-800">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2.5">#</th>
                <th className="px-3 py-2.5">Echipă</th>
                <th className="px-3 py-2.5 text-center">J</th>
                <th className="px-3 py-2.5 text-center">V</th>
                <th className="px-3 py-2.5 text-center">E</th>
                <th className="px-3 py-2.5 text-center">Î</th>
                <th className="px-3 py-2.5 text-center">GM</th>
                <th className="px-3 py-2.5 text-center">GP</th>
                <th className="px-3 py-2.5 text-center font-bold text-amber-400">PCT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950/60">
              {standings.map((s) => (
                <tr key={s.pos} className={s.pos <= 4 ? "bg-emerald-950/20" : ""}>
                  <td className="px-3 py-2.5 font-bold">{s.pos}</td>
                  <td className="px-3 py-2.5 font-medium">{s.team}</td>
                  <td className="px-3 py-2.5 text-center">{s.j}</td>
                  <td className="px-3 py-2.5 text-center">{s.v}</td>
                  <td className="px-3 py-2.5 text-center">{s.e}</td>
                  <td className="px-3 py-2.5 text-center">{s.i}</td>
                  <td className="px-3 py-2.5 text-center">{s.gm}</td>
                  <td className="px-3 py-2.5 text-center">{s.gp}</td>
                  <td className="px-3 py-2.5 text-center font-bold text-amber-400">{s.pct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : events.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">Niciun eveniment disponibil momentan.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {events.map((e) => (
            <div key={e.id} className="rounded-xl bg-zinc-900/70 p-4 ring-1 ring-zinc-800 hover:ring-zinc-700 transition">
              <div className="mb-2 flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1 font-bold uppercase tracking-wide text-red-400">
                  <Trophy className="h-3 w-3" /> {e.competition}
                </span>
                <span className="text-zinc-500">{e.sport}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex-1 truncate text-sm font-semibold">{e.home}</span>
                <span className="rounded bg-zinc-800 px-2 py-1 text-xs font-black text-amber-400">
                  {e.score || "vs"}
                </span>
                <span className="flex-1 truncate text-right text-sm font-semibold">{e.away}</span>
              </div>
              <div className="mt-2 flex items-center gap-1 text-[11px] text-zinc-500">
                <CalendarDays className="h-3 w-3" /> {fmtDate(e.date)} • {e.status}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
