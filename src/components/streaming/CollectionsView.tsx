"use client";

// ============================================================
// CollectionsView — FAZA 11: COLECȚIILE MELE (playlists personale)
// Utilizatorul își organizează conținutul încărcat în colecții
// proprii (ex: „Desene pentru copii”, „Meciuri importante”).
// Stocare 100% Neon (collections + collection_items).
// ============================================================

import { useCallback, useEffect, useState } from "react";
import {
  Plus, Trash2, PlayCircle, ChevronLeft, FolderOpen, Layers, Loader2,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import type { MediaItem, Collection, CollectionItem } from "./types";
import { api } from "./api";

type Props = {
  authed: boolean;
  refreshKey: number;
  onOpen: (i: MediaItem) => void;
  onPlay: (i: MediaItem) => void;
};

const collToMedia = (c: CollectionItem): MediaItem => ({
  id: String(c.id),
  mediaType: "neon",
  title: c.title,
  poster: c.thumbnail,
  backdrop: c.backdrop,
  overview: "",
  year: c.year ? String(c.year) : "",
  rating: c.rating,
  source: "neon",
  sourceUrl: c.sourceUrl,
  embedCode: c.embedCode,
  provider: c.provider,
  neonId: c.id,
  signed: Boolean(c.signed),
});

export function CollectionsView({ authed, refreshKey, onOpen, onPlay }: Props) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [openColl, setOpenColl] = useState<Collection | null>(null);
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [descr, setDescr] = useState("");
  const [creating, setCreating] = useState(false);

  const loadList = useCallback(async () => {
    if (!authed) { setCollections([]); setLoading(false); return; }
    setLoading(true);
    try {
      const r = await api.collections<{ collections: Collection[] }>();
      setCollections(r.collections || []);
    } catch { setCollections([]); }
    finally { setLoading(false); }
  }, [authed]);

  useEffect(() => { loadList(); }, [loadList, refreshKey]);

  const openDetail = useCallback(async (c: Collection) => {
    setOpenColl(c);
    setItems([]);
    setItemsLoading(true);
    try {
      const r = await api.collections<{ items: CollectionItem[] }>(`id=${c.id}`);
      setItems(r.items || []);
    } catch { setItems([]); }
    finally { setItemsLoading(false); }
  }, []);

  const createCollection = async () => {
    if (name.trim().length < 1) return;
    setCreating(true);
    try {
      await api.collectionsPost({ action: "create", name: name.trim(), description: descr.trim() });
      toast({ title: "Colecție creată ✅", description: `„${name.trim()}” este gata de umplut.` });
      setName(""); setDescr(""); setCreateOpen(false);
      loadList();
    } catch {
      toast({ title: "Eroare", description: "Nu am putut crea colecția.", variant: "destructive" });
    } finally { setCreating(false); }
  };

  const removeItem = async (contentId: number) => {
    if (!openColl) return;
    try {
      await api.collectionsPost({ action: "remove", id: openColl.id, contentId });
      setItems((prev) => prev.filter((i) => i.id !== contentId));
      setCollections((prev) => prev.map((c) =>
        c.id === openColl.id ? { ...c, itemsCount: Math.max(0, c.itemsCount - 1) } : c
      ));
      toast({ title: "Eliminat din colecție" });
    } catch {
      toast({ title: "Eroare", description: "Nu am putut elimina itemul.", variant: "destructive" });
    }
  };

  const deleteCollection = async (c: Collection) => {
    try {
      await api.collectionsPost({ action: "delete", id: c.id });
      toast({ title: "Colecție ștearsă", description: `„${c.name}” a fost ștearsă.` });
      if (openColl?.id === c.id) setOpenColl(null);
      loadList();
    } catch {
      toast({ title: "Eroare", description: "Nu am putut șterge colecția.", variant: "destructive" });
    }
  };

  if (!authed) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-4 text-5xl">🗂️</div>
        <h2 className="text-xl font-black">Colecțiile tale așteaptă</h2>
        <p className="mt-2 max-w-md text-sm text-zinc-500">
          Conectează-te pentru a crea colecții (playlists) cu conținutul tău încărcat —
          se salvează în contul tău, pe toate dispozitivele.
        </p>
      </div>
    );
  }

  /* ---------- detaliu colecție ---------- */
  if (openColl) {
    return (
      <div className="px-4 py-6 sm:px-6">
        <button
          onClick={() => setOpenColl(null)}
          className="mb-4 flex items-center gap-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-200"
        >
          <ChevronLeft className="h-4 w-4" /> Toate colecțiile
        </button>
        <div className="mb-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-zinc-800">
              {openColl.posterUrl ? (
                <img src={openColl.posterUrl} alt={openColl.name} className="h-full w-full object-cover" />
              ) : (
                <FolderOpen className="h-7 w-7 text-zinc-600" />
              )}
            </div>
            <div>
              <h2 className="text-xl font-black sm:text-2xl">{openColl.name}</h2>
              <p className="text-xs text-zinc-500">
                {openColl.description || "Fără descriere"} • {items.length} conținuturi
              </p>
            </div>
          </div>
          <button
            onClick={() => deleteCollection(openColl)}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-xs font-bold text-zinc-400 ring-1 ring-zinc-800 hover:bg-red-950 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" /> Șterge
          </button>
        </div>

        {itemsLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-zinc-600" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-800 text-center">
            <Layers className="mb-3 h-9 w-9 text-zinc-700" />
            <p className="text-sm font-bold text-zinc-300">Colecția e goală</p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-zinc-600">
              Deschide orice conținut din platformă și apasă „Adaugă la colecție”.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {items.map((c) => (
              <div key={c.id} className="group" data-ai-click>
                <div className="relative aspect-video overflow-hidden rounded-xl bg-zinc-800 ring-1 ring-white/10">
                  {c.thumbnail || c.backdrop ? (
                    <img src={c.thumbnail || c.backdrop || ""} alt={c.title} className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-3xl">🎬</div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      aria-label={`Redă ${c.title}`}
                      onClick={() => onPlay(collToMedia(c))}
                      className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-500"
                    >
                      <PlayCircle className="h-5 w-5" />
                    </button>
                    <button
                      aria-label={`Elimină ${c.title}`}
                      onClick={() => removeItem(c.id)}
                      className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900/90 text-zinc-300 hover:bg-red-950 hover:text-red-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-300">
                    {c.provider}
                  </span>
                </div>
                <button
                  onClick={() => onOpen(collToMedia(c))}
                  className="mt-1.5 block w-full cursor-pointer truncate text-left text-[13px] font-medium hover:text-red-400"
                >
                  {c.title}
                </button>
                <p className="truncate text-[10px] text-zinc-600">{c.contentType}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ---------- lista colecțiilor ---------- */
  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black sm:text-2xl">🗂️ Colecțiile Mele</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Playlists personale cu conținutul tău — salvate 100% în Neon.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="flex h-10 items-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-bold text-white hover:bg-red-500"
        >
          <Plus className="h-4 w-4" /> Colecție nouă
        </button>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-7 w-7 animate-spin text-zinc-600" />
        </div>
      ) : collections.length === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-800 text-center">
          <FolderOpen className="mb-3 h-10 w-10 text-zinc-700" />
          <p className="text-sm font-bold text-zinc-300">Nu ai încă nicio colecție</p>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-600">
            Creează prima colecție și organizează conținutul tău: filme, canale TV,
            muzică, sport — totul adăugat de tine, totul în Neon.
          </p>
          <button
            onClick={() => setCreateOpen(true)}
            className="mt-4 flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-500"
          >
            <Plus className="h-4 w-4" /> Creează prima colecție
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {collections.map((c) => (
            <div key={c.id} className="group" data-ai-click>
              <button
                onClick={() => openDetail(c)}
                className="relative block aspect-video w-full overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/10 transition hover:ring-red-600/60"
              >
                {c.posterUrl ? (
                  <img src={c.posterUrl} alt={c.name} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <FolderOpen className="h-10 w-10 text-zinc-700" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                <span className="absolute bottom-2 left-2.5 rounded bg-black/75 px-2 py-0.5 text-[10px] font-bold text-zinc-200">
                  {c.itemsCount} conținuturi
                </span>
                {c.isPublic && (
                  <span className="absolute right-2 top-2 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                    public
                  </span>
                )}
                <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                  <PlayCircle className="h-11 w-11 text-white drop-shadow" />
                </span>
              </button>
              <button onClick={() => openDetail(c)} className="mt-1.5 block w-full truncate text-left text-sm font-bold hover:text-red-400">
                {c.name}
              </button>
              <p className="truncate text-[11px] text-zinc-600">{c.description || "Fără descriere"}</p>
            </div>
          ))}
        </div>
      )}

      {/* dialog creare colecție */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md bg-zinc-950 border-zinc-800">
          <DialogHeader>
            <DialogTitle>Colecție nouă</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nume colecție (ex: Desene pentru copii)"
              maxLength={120}
              aria-label="Nume colecție"
            />
            <Textarea
              value={descr}
              onChange={(e) => setDescr(e.target.value)}
              placeholder="Descriere (opțional)"
              maxLength={500}
              rows={3}
              aria-label="Descriere colecție"
            />
            <button
              onClick={createCollection}
              disabled={creating || name.trim().length < 1}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Creează colecția
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
