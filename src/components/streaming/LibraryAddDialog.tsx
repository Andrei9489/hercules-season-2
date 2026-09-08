"use client";

// ============================================================
// LibraryAddDialog — STUDIOUL DE ÎNCĂRCARE UNIVERSAL (Faza 8)
// Utilizatorul încarcă conținutul REAL al platformei:
//   • link direct: MP4 / WebM / HLS (.m3u8) / DASH (.mpd)
//   • platforme: YouTube, OK.ru, Vimeo, TikTok, Dailymotion,
//     Rumble, Twitch, Facebook, VK, Streamable, Drive, Bilibili...
//   • cod embed: <iframe> / <script> / <object> / <video>
//   • orice sursă necunoscută → iframe generic cu fallback extern
// MOD BULK: un element pe linie (max 50 / batch) — metadatele
// comune (tip / brand / țară / an / genuri) se aplică tuturor.
// Metadatele se salvează în NEON — nimic local.
// ============================================================

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
  onAdded: (item?: LibraryItem) => void;
};

const TYPES = [
  ["video", "Video"], ["movie", "Film"], ["series", "Serial"], ["anime", "Anime"],
  ["cartoon", "Desene animate"], ["documentary", "Documentar"], ["music", "Muzică"],
  ["sport", "Sport"], ["gaming", "Gaming"], ["news", "Știri"], ["radio", "Radio"],
  ["showbiz", "Show-biz"], ["telenovela", "Telenovelă"],
];

const BRANDS = ["", "marvel", "dc", "disney", "pixar", "cartoon-network", "jetix", "fox-kids", "boomerang", "minimax", "ghibli"];

/** Împarte textarea-ul pe linii — fiecare linie = o sursă (URL sau cod embed). */
function splitSources(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function LibraryAddDialog({ open, onClose, onAdded }: Props) {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [posterUrl, setPosterUrl] = useState("");
  const [description, setDescription] = useState("");
  const [year, setYear] = useState("");
  const [genres, setGenres] = useState("");
  const [type, setType] = useState("video");
  const [brand, setBrand] = useState("");
  const [country, setCountry] = useState("");
  const [saving, setSaving] = useState(false);

  const lines = useMemo(() => splitSources(input), [input]);

  const detected = useMemo(() => {
    if (lines.length === 0) return null;
    try {
      return resolveSource(lines[0], { parent: typeof window !== "undefined" ? window.location.hostname : "" });
    } catch {
      return null;
    }
  }, [lines]);

  const detectedCount = useMemo(() => {
    let ok = 0;
    for (const l of lines) {
      try { if (resolveSource(l, {})) ok++; } catch { /* nerecunoscut */ }
    }
    return ok;
  }, [lines]);

  // titlu automat din URL (doar în mod singular)
  useEffect(() => {
    if (lines.length !== 1 || !lines[0] || title) return;
    const d = detected;
    if (!d) return;
    const ref = d.kind === "html" ? "" : (d as { src?: string; url?: string }).src || (d as { url?: string }).url || "";
    if (ref.startsWith("http")) setTitle(titleFromUrl(ref));
  }, [lines, detected, title]);

  const reset = () => {
    setInput(""); setTitle(""); setPosterUrl(""); setDescription("");
    setYear(""); setGenres(""); setType("video"); setBrand(""); setCountry("");
  };

  const save = async () => {
    if (lines.length === 0) {
      toast({ title: "Introdu cel puțin un link sau cod embed", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const bulk = lines.length > 1;
      const r = await api.libraryPost<{ added: number; duplicates: string[]; failed: string[]; items: LibraryItem[] }>({
        action: "add",
        items: bulk ? lines : undefined,
        input: bulk ? undefined : lines[0],
        title: title.trim() || undefined,
        posterUrl: posterUrl.trim() || undefined,
        description: description.trim() || undefined,
        year: year.trim() || undefined,
        genres: genres.trim() || undefined,
        contentType: type,
        brand: brand || undefined,
        country: country.trim() || undefined,
      });
      const parts = [`${r.added} salvat(e) în Neon ✅`];
      if (r.duplicates?.length) parts.push(`${r.duplicates.length} duplicate ignorate`);
      if (r.failed?.length) parts.push(`${r.failed.length} eșuat(e)`);
      toast({
        title: parts.join(" • "),
        description: bulk
          ? `${lines.length} surse procesate${r.duplicates?.length ? ` (ex: ${r.duplicates[0]})` : ""}`
          : `${r.items?.[0]?.title || lines[0].slice(0, 50)}`,
      });
      onAdded(r.items?.[0]);
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
      <DialogContent aria-describedby={undefined} className="max-h-[92vh] max-w-lg overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="text-lg font-black">Studiul de încărcare universal</DialogTitle>
        </DialogHeader>
        <p className="-mt-1 text-xs text-zinc-500">
          Lipește <b className="text-zinc-300">un element pe linie</b> — link de redare
          (YouTube, OK.ru, Vimeo, TikTok, Dailymotion, Rumble, Twitch, MP4, HLS, DASH...) sau
          <b className="text-zinc-300"> cod embed</b> (iframe / script / HTML). Titlul și miniatura
          reale se extrag automat unde e posibil.
        </p>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={"https://www.youtube.com/watch?v=...\nhttps://ok.ru/video/12345\nhttps://vimeo.com/76979871\n<iframe src=\"https://www.dailymotion.com/embed/video/x8...\"></iframe>\nhttps://example.com/film.mp4\nhttps://stream.tv/live/index.m3u8"}
          rows={5}
          className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-600/50"
        />

        {input.trim() && (
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ${
            detectedCount > 0 ? "bg-emerald-500/10 text-emerald-300 ring-emerald-600/30" : "bg-red-500/10 text-red-300 ring-red-600/30"
          }`}>
            {detectedCount > 0 ? (
              <>
                ✓ {detectedCount}/{lines.length} sursă/e detectată/e
                {lines.length === 1 && detected && (
                  <> • <b>{detected.providerLabel}</b> • redare: {detected.kind === "iframe" ? "iframe embed" : detected.kind === "video" ? "player nativ" : detected.kind === "hls" ? "HLS adaptiv" : detected.kind === "dash" ? "DASH adaptiv" : detected.kind === "html" ? "embed sandboxat" : "iframe generic"}</>
                )}
                {lines.length > 1 && <span className="text-emerald-400/70">— mod BULK</span>}
              </>
            ) : (
              <>✗ Nicio sursă recunoscută — dar poți încerca oricum redarea generică</>
            )}
          </div>
        )}

        {lines.length <= 1 && (
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Titlu (auto din link / oEmbed, opțional editabil)"
            className="border-zinc-800 bg-zinc-900 text-sm"
          />
        )}

        <Input
          value={posterUrl}
          onChange={(e) => setPosterUrl(e.target.value)}
          placeholder="URL poster (opțional — altfel miniatură automată)"
          className="border-zinc-800 bg-zinc-900 text-sm"
        />

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Descriere (opțional)"
          rows={2}
          className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-600/50"
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
            aria-label="Brand / univers"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-900 px-2 text-sm text-zinc-200"
          >
            {BRANDS.map((b) => <option key={b || "none"} value={b}>{b ? b.replace(/-/g, " ") : "— fără brand —"}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Input
            value={year}
            onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="An (ex: 2024)"
            className="border-zinc-800 bg-zinc-900 text-sm"
          />
          <Input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="Țară"
            className="border-zinc-800 bg-zinc-900 text-sm"
          />
          <Input
            value={genres}
            onChange={(e) => setGenres(e.target.value)}
            placeholder="Genuri (virgulă)"
            className="border-zinc-800 bg-zinc-900 text-sm"
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50 transition"
          >
            {saving
              ? "Se salvează în Neon..."
              : lines.length > 1
                ? `Salvează ${lines.length} conținuturi în biblioteca Neon`
                : "Salvează în biblioteca Neon"}
          </button>
          <button
            onClick={reset}
            className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800 transition"
          >
            Curăță
          </button>
        </div>
        <p className="text-[11px] text-zinc-600">
          Sfat: orice sursă web poate fi redată — providerii necunoscuți primesc iframe generic cu
          fallback extern. Aceleași linkuri adăugate repetat nu se dublează (idempotent).
        </p>
      </DialogContent>
    </Dialog>
  );
}
