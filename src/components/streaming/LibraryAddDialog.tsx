"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { resolveSource, titleFromUrl } from "@/lib/source-resolver";
import type { LibraryItem } from "./types";
import { api } from "./api";

type Props = {
  open: boolean;
  onClose: () => void;
  onAdded: (item: LibraryItem) => void;
};

const TYPES = [
  ["video", "Video"], ["movie", "Film"], ["series", "Serial"], ["anime", "Anime"],
  ["cartoon", "Desene animate"], ["documentary", "Documentar"], ["music", "Muzică"],
  ["sport", "Sport"], ["gaming", "Gaming"], ["showbiz", "Show-biz"], ["telenovela", "Telenovelă"],
];

const BRANDS = ["", "marvel", "dc", "disney", "pixar", "cartoon-network", "jetix", "fox-kids", "boomerang", "minimax", "ghibli"];

/**
 * Dialog „Adaugă conținut": URL link sau cod embed (iframe/JS)
 * → detecție live a providerului → salvare metadate în Neon.
 */
export function LibraryAddDialog({ open, onClose, onAdded }: Props) {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("video");
  const [brand, setBrand] = useState("");
  const [country, setCountry] = useState("");
  const [saving, setSaving] = useState(false);

  const detected = useMemo(() => {
    if (!input.trim()) return null;
    try {
      return resolveSource(input, { parent: typeof window !== "undefined" ? window.location.hostname : "" });
    } catch {
      return null;
    }
  }, [input]);

  // titlu automat din URL
  useEffect(() => {
    if (!input.trim() || title) return;
    if (!detected) return;
    const ref = detected.kind === "html" ? "Cod embed personalizat" : (detected as { src?: string; url?: string }).src || (detected as { url?: string }).url || "";
    if (ref.startsWith("http")) setTitle(titleFromUrl(ref));
  }, [input, detected, title]);

  const reset = () => {
    setInput(""); setTitle(""); setType("video"); setBrand(""); setCountry("");
  };

  const save = async () => {
    if (!input.trim()) {
      toast({ title: "Introdu un link sau cod embed", variant: "destructive" });
      return;
    }
    if (!detected) {
      toast({ title: "Sursă nerecunoscută", description: "Verifică linkul sau codul embed.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await api.libraryPost<{ item: LibraryItem }> ({
        action: "add",
        input: input.trim(),
        title: title.trim() || undefined,
        contentType: type,
        brand: brand || undefined,
        country: country.trim() || undefined,
      });
      toast({
        title: "Salvat în Neon ✅",
        description: `${r.item.title} • sursă: ${detected.providerLabel}`,
      });
      onAdded(r.item);
      reset();
      onClose();
    } catch {
      toast({ title: "Eroare la salvare în Neon", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-lg border-zinc-800 bg-zinc-950 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="text-lg font-black">Adaugă conținut universal</DialogTitle>
        </DialogHeader>
        <p className="-mt-1 text-xs text-zinc-500">
          Lipește un <b>link de redare</b> (YouTube, Vimeo, Dailymotion, OK.ru, Rumble, Twitch, TikTok, MP4, HLS...)
          sau un <b>cod embed</b> (iframe / script / HTML). Metadatele se salvează în Neon Cloud.
        </p>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={"https://www.youtube.com/watch?v=...\nhttps://ok.ru/video/...\n<iframe src=\"...\"></iframe>"}
          rows={3}
          className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-600/50"
        />

        {input.trim() && (
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ${detected ? "bg-emerald-500/10 text-emerald-300 ring-emerald-600/30" : "bg-red-500/10 text-red-300 ring-red-600/30"}`}>
            {detected ? (
              <>✓ Sursă detectată: <b>{detected.providerLabel}</b> • redare: {detected.kind === "iframe" ? "iframe embed" : detected.kind === "video" ? "player nativ" : detected.kind === "hls" ? "HLS adaptiv" : detected.kind === "html" ? "embed sandoboxat" : "iframe generic"}</>
            ) : (
              <>✗ Link sau cod nerecunoscut — dar poți încerca oricum redarea generică</>
            )}
          </div>
        )}

        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Titlu (auto din link, optional editabil)"
          className="border-zinc-800 bg-zinc-900 text-sm"
        />

        <div className="grid grid-cols-2 gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Tip conținut"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-sm text-zinc-200"
          >
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            aria-label="Brand"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-sm text-zinc-200"
          >
            {BRANDS.map((b) => <option key={b || "none"} value={b}>{b ? b.replace("-", " ") : "— fără brand —"}</option>)}
          </select>
        </div>

        <Input
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          placeholder="Țară (ex: România, SUA, Japonia...)"
          className="border-zinc-800 bg-zinc-900 text-sm"
        />

        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50 transition"
          >
            {saving ? "Se salvează în Neon..." : "Salvează în biblioteca Neon"}
          </button>
          <button
            onClick={() => { reset(); }}
            className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800 transition"
          >
            Curăță
          </button>
        </div>
        <p className="text-[11px] text-zinc-600">
          Sfat: orice sursă web poate fi redată — providerii necunoscuți primesc iframe generic cu fallback extern.
        </p>
      </DialogContent>
    </Dialog>
  );
}
