"use client";

import { useCallback, useEffect, useState } from "react";
import { Heart, MessageSquare, UserPlus, UserCheck, Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";

export type SocialCommentItem = {
  id: string;
  userId: string;
  userName: string | null;
  userImage: string | null;
  body: string;
  createdAt: string;
  likes: number;
  viewerLiked: boolean;
};

function timeAgoRo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `acum ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `acum ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `acum ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `acum ${d}z`;
  return new Date(iso).toLocaleDateString("ro-RO");
}

type Props = {
  mediaId: string;
  mediaType: string;
  authed: boolean;
};

/** FAZA 20b — comentarii sociale reale din Neon (listă + postare + like + follow autor). */
export function CommentsPanel({ mediaId, mediaType, authed }: Props) {
  const [items, setItems] = useState<SocialCommentItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [followed, setFollowed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/social/comments?mediaId=${encodeURIComponent(mediaId)}&mediaType=${encodeURIComponent(mediaType)}&limit=20`, { cache: "no-store" });
      const d = await r.json() as { items: SocialCommentItem[]; total: number };
      setItems(d.items || []);
      setTotal(d.total || 0);
    } catch {
      setItems([]);
    }
  }, [mediaId, mediaType]);

  useEffect(() => {
    if (!mediaId) return;
    setItems(null);
    void load();
  }, [mediaId, load]);

  async function submit() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await fetch("/api/social/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId, mediaType, body }),
      });
      if (r.status === 401) {
        toast({ title: "Autentifică-te pentru a comenta" });
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast({ title: d.error || "Eroare la trimitere" });
        return;
      }
      setDraft("");
      await load();
      toast({ title: "Comentariu publicat în Neon ✅" });
    } finally {
      setSending(false);
    }
  }

  async function toggleLike(c: SocialCommentItem) {
    if (!authed) {
      toast({ title: "Autentifică-te pentru a reacționa" });
      return;
    }
    // optimist
    setItems((prev) => prev ? prev.map((x) => x.id === c.id ? {
      ...x, viewerLiked: !x.viewerLiked, likes: x.likes + (x.viewerLiked ? -1 : 1),
    } : x) : prev);
    const r = await fetch("/api/social/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentId: c.id }),
    }).catch(() => null);
    if (!r || !r.ok) {
      // revert la eroare
      setItems((prev) => prev ? prev.map((x) => x.id === c.id ? {
        ...x, viewerLiked: x.viewerLiked, likes: x.likes + (c.viewerLiked ? 1 : -1),
      } : x) : prev);
      toast({ title: "Eroare la reacție" });
    }
  }

  async function followAuthor(c: SocialCommentItem) {
    if (!authed) {
      toast({ title: "Autentifică-te pentru a urmări" });
      return;
    }
    const active = !followed.has(c.userId);
    setFollowed((prev) => {
      const n = new Set(prev);
      if (active) n.add(c.userId); else n.delete(c.userId);
      return n;
    });
    const r = await fetch("/api/social/follow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: c.userId }),
    });
    if (!r.ok) {
      setFollowed((prev) => {
        const n = new Set(prev);
        if (active) n.delete(c.userId); else n.add(c.userId);
        return n;
      });
      toast({ title: "Eroare la urmărire" });
    } else {
      toast({ title: active ? "Îl urmărești acum — activitatea apare în feed" : "Nu îl mai urmărești" });
    }
  }

  async function more() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/social/comments?mediaId=${encodeURIComponent(mediaId)}&mediaType=${encodeURIComponent(mediaType)}&limit=20&offset=${items?.length || 0}`, { cache: "no-store" });
      const d = await r.json() as { items: SocialCommentItem[]; total: number };
      setItems((prev) => [...(prev || []), ...(d.items || [])]);
      setTotal(d.total || 0);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-bold">
        <MessageSquare className="h-4 w-4 text-red-500" />
        Comentarii {total > 0 && <span className="text-zinc-500">({total})</span>}
        <span className="ml-auto text-[10px] font-normal uppercase tracking-wider text-zinc-600">Neon social</span>
      </p>

      {authed ? (
        <div className="mb-4">
          <Textarea
            placeholder="Scrie un comentariu public (max. 1000 caractere)..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={1000}
            className="mb-2 min-h-[64px] border-zinc-800 bg-zinc-950 text-sm text-zinc-200"
          />
          <div className="flex items-center justify-between">
            <span className={`text-xs ${draft.length > 900 ? "text-amber-500" : "text-zinc-600"}`}>
              {draft.length}/1000
            </span>
            <Button
              size="sm"
              onClick={submit}
              disabled={!draft.trim() || sending}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Comentează"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mb-4 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-500">
          Autentifică-te pentru a comenta și a reacționa.
        </p>
      )}

      {items === null ? (
        <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Se încarcă comentariile...
        </div>
      ) : items.length === 0 ? (
        <p className="py-3 text-sm text-zinc-500">
          Fii primul care comentează acest conținut.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((c) => (
            <li key={c.id} className="rounded-md border border-zinc-800/70 bg-zinc-950/60 p-3">
              <div className="mb-1.5 flex items-center gap-2">
                {c.userImage ? (
                   
                  <img src={c.userImage} alt="" className="h-7 w-7 rounded-full" />
                ) : (
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800 text-xs text-zinc-300">
                    {(c.userName || "U").slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="text-sm font-semibold text-zinc-200">{c.userName || "Utilizator"}</span>
                <span className="text-xs text-zinc-600">{timeAgoRo(c.createdAt)}</span>
                {authed && c.userId && (
                  <button
                    onClick={() => followAuthor(c)}
                    className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                      followed.has(c.userId)
                        ? "bg-zinc-800 text-zinc-300"
                        : "bg-red-600/20 text-red-400 hover:bg-red-600/30"
                    }`}
                    aria-label={`Urmărește pe ${c.userName || "utilizator"}`}
                  >
                    {followed.has(c.userId) ? <UserCheck className="h-3 w-3" /> : <UserPlus className="h-3 w-3" />}
                    {followed.has(c.userId) ? "Urmărit" : "Urmărește"}
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm text-zinc-300">{c.body}</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => toggleLike(c)}
                  className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
                    c.viewerLiked ? "bg-red-600/20 text-red-400" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                  aria-label="Îmi place"
                >
                  <Heart className={`h-3.5 w-3.5 ${c.viewerLiked ? "fill-red-500 text-red-500" : ""}`} />
                  {c.likes > 0 ? c.likes : ""}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {items !== null && items.length < total && (
        <button
          onClick={more}
          disabled={loadingMore}
          className="mt-3 w-full rounded-md border border-zinc-800 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
        >
          {loadingMore ? "Se încarcă..." : `Încarcă mai multe (${total - items.length} rămase)`}
        </button>
      )}
    </div>
  );
}
