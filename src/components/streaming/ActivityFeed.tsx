"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Heart, UserPlus, Play, Star, ListPlus, Globe, Users } from "lucide-react";

type ActivityItem = {
  id: number;
  userId: string;
  userName: string | null;
  userImage: string | null;
  kind: string;
  title: string | null;
  poster: string | null;
  createdAt: string;
};

const KIND_META: Record<string, { icon: typeof Play; text: (t: string | null) => string; color: string }> = {
  watch: { icon: Play, text: (t) => `a vizionat ${t || "un conținut"}`, color: "text-green-400" },
  comment: { icon: MessageSquare, text: (t) => `a comentat la ${t || "un conținut"}`, color: "text-blue-400" },
  like: { icon: Heart, text: () => "a reacționat la un comentariu", color: "text-red-400" },
  follow: { icon: UserPlus, text: () => "a început să urmărească pe cineva", color: "text-purple-400" },
  list_add: { icon: ListPlus, text: (t) => `a salvat ${t || "un conținut"} în listă`, color: "text-amber-400" },
  review: { icon: Star, text: (t) => `a evaluat ${t || "un conținut"}`, color: "text-yellow-400" },
};

function timeAgoRo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `acum ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `acum ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `acum ${h}h`;
  return `acum ${Math.floor(h / 24)}z`;
}

/** FAZA 20b — feed social real din Neon (global pentru anonimi, „following" pentru autentificați). */
export function ActivityFeed({ authed }: { authed: boolean }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [scope, setScope] = useState<"global" | "following">("global");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/social/feed?limit=10", { cache: "no-store" });
        const d = await r.json() as { items: ActivityItem[]; scope: "global" | "following" };
        if (!alive) return;
        setItems(d.items || []);
        setScope(d.scope || "global");
      } catch {
        if (alive) setItems([]);
      }
    })();
    return () => { alive = false; };
  }, [authed]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-bold">
        {scope === "following" ? <Users className="h-4 w-4 text-red-500" /> : <Globe className="h-4 w-4 text-red-500" />}
        {scope === "following" ? "Activitatea celor pe care îi urmărești" : "Activitatea comunității"}
        <span className="ml-auto text-[10px] font-normal uppercase tracking-wider text-zinc-600">
          {authed ? "feed personal" : "live din Neon"}
        </span>
      </p>
      {items === null ? (
        <p className="py-2 text-sm text-zinc-600">Se încarcă...</p>
      ) : items.length === 0 ? (
        <p className="py-2 text-sm text-zinc-500">
          Încă nimic — comentează sau vizionează ceva pentru a porni fluxul social.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {items.map((a) => {
            const meta = KIND_META[a.kind] || KIND_META.watch;
            const Icon = meta.icon;
            return (
              <li key={a.id} className="flex items-center gap-2.5 rounded-lg border border-zinc-800/70 bg-zinc-950/60 px-3 py-2">
                {a.userImage ? (
                   
                  <img src={a.userImage} alt="" className="h-8 w-8 shrink-0 rounded-full" />
                ) : (
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs text-zinc-300">
                    {(a.userName || "U").slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-zinc-300">
                    <span className="font-semibold text-zinc-100">{a.userName || "Utilizator"}</span>{" "}
                    <span className={meta.color}>{meta.text(a.title)}</span>
                  </p>
                  <p className="text-[10px] text-zinc-600">{timeAgoRo(a.createdAt)}</p>
                </div>
                <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.color}`} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
