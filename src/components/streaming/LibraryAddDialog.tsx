"use client";

// ============================================================
// LibraryAddDialog — STUDIOUL DE ÎNCĂRCARE UNIVERSAL (Faza 8+9)
// Utilizatorul încarcă conținutul REAL al platformei:
//   • link direct: MP4 / WebM / HLS (.m3u8) / DASH (.mpd)
//   • platforme: YouTube, OK.ru, Vimeo, TikTok, Dailymotion,
//     Rumble, Twitch, Facebook, VK, Streamable, Drive, Bilibili...
//   • cod embed: <iframe> / <script> / <object> / <video>
//   • orice sursă necunoscută → iframe generic cu fallback extern
//   • PLAYLIST M3U/M3U8 (Faza 9): paste conținut sau URL → canale
//     TV/radio cu tvg-logo, group-title multi-categorii, calitate,
//     [Geo-blocked]/[Not 24/7] → bulk idempotent în Neon
// MOD BULK: un element pe linie (max 50 / batch) — metadatele
// comune (tip / brand / țară / an / genuri) se aplică tuturor.
// Metadatele se salvează în NEON — nimic local.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { resolveSource, titleFromUrl } from "@/lib/source-resolver";
import { parseM3U } from "@/lib/m3u-parser";
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

type M3UImportResult = {
  ok: boolean;
  playlistName: string;
  parsed: number;
  parsedRadio: number;
  added: number;
  duplicates: number;
  skipped: number;
  errors: string[];
  topGroups: { group: string; n: number }[];
};

export function LibraryAddDialog({ open, onClose, onAdded }: Props) {
  const [mode, setMode] = useState<"sources" | "m3u">("sources");

  // ---- mod SURSE (Faza 8) ----
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

  // ---- Faza 10: ACCES SECURIZAT (token/HMAC/JWT) ----
  const [secOn, setSecOn] = useState(false);
  const [secType, setSecType] = useState("query");
  const [secParam, setSecParam] = useState("token");
  const [secSecret, setSecSecret] = useState("");
  const [secTtl, setSecTtl] = useState("300");

  // ---- mod PLAYLIST M3U (Faza 9) ----
  const [m3uText, setM3uText] = useState("");
  const [m3uUrl, setM3uUrl] = useState("");
  const [importing, setImporting] = useState(false);

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

  // preview parsare M3U client-side (parserul e server-safe = merge și în browser)
  const m3uPreview = useMemo(() => {
    if (mode !== "m3u" || !m3uText.trim()) return null;
    try {
      const r = parseM3U(m3uText);
      const groups = new Map<string, number>();
      for (const ch of r.channels) for (const g of ch.groups) groups.set(g, (groups.get(g) || 0) + 1);
      return {
        channels: r.channels.length,
        radio: r.channels.filter((c) => c.isRadio).length,
        playlistName: r.playlistName,
        errors: r.errors,
        topGroups: [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
        sample: r.channels.slice(0, 4).map((c) => c.name),
      };
    } catch {
      return null;
    }
  }, [mode, m3uText]);

  // titlu automat din URL (doar în mod singular)
  useEffect(() => {
    if (mode !== "sources" || lines.length !== 1 || !lines[0] || title) return;
    const d = detected;
    if (!d) return;
    const ref = d.kind === "html" ? "" : (d as { src?: string; url?: string }).src || (d as { url?: string }).url || "";
    if (ref.startsWith("http")) setTitle(titleFromUrl(ref));
  }, [mode, lines, detected, title]);

  const reset = () => {
    setInput(""); setTitle(""); setPosterUrl(""); setDescription("");
    setYear(""); setGenres(""); setType("video"); setBrand(""); setCountry("");
    setSecOn(false); setSecSecret(""); setSecParam("token"); setSecType("query"); setSecTtl("300");
    setM3uText(""); setM3uUrl("");
  };

  const save = async () => {
    if (lines.length === 0) {
      toast({ title: "Introdu cel puțin un link sau cod embed", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const bulk = lines.length > 1;
      // Faza 10 — semnarea se aplică doar în mod singular, pe streamuri directe
      const direct = detected && ["video", "hls", "dash", "ts"].includes(detected.kind);
      const signing = secOn && !bulk && direct && secSecret.trim().length >= 4
        ? { type: secType, param: secParam.trim() || "token", secret: secSecret.trim(), ttlSec: Number(secTtl) || 300 }
        : undefined;
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
        signing,
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

  const importM3U = async () => {
    if (!m3uText.trim() && !m3uUrl.trim()) {
      toast({ title: "Lipește conținutul M3U sau introdu un URL de playlist", variant: "destructive" });
      return;
    }
    setImporting(true);
    try {
      const r = await api.libraryPost<M3UImportResult>({ action: "m3u", content: m3uText || undefined, url: m3uUrl || undefined });
      const parts = [`${r.added} canale importate în Neon ✅`];
      if (r.duplicates) parts.push(`${r.duplicates} duplicate`);
      if (r.skipped) parts.push(`${r.skipped} ignorate`);
      toast({
        title: parts.join(" • "),
        description: `„${r.playlistName}" — ${r.parsed} canale${r.parsedRadio ? ` (${r.parsedRadio} radio)` : ""}${r.topGroups.length ? ` • grupuri: ${r.topGroups.slice(0, 3).map((g) => g.group).join(", ")}` : ""}`,
      });
      onAdded();
      reset();
      onClose();
    } catch {
      toast({ title: "Eroare la importul M3U — verifică formatul/URL-ul", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[92vh] max-w-lg overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="text-lg font-black">Studiul de încărcare universal</DialogTitle>
        </DialogHeader>

        {/* comutator mod: Surse | Playlist M3U */}
        <div className="flex rounded-lg bg-zinc-900 p-1 ring-1 ring-zinc-800" role="tablist" aria-label="Mod încărcare">
          <button
            role="tab"
            aria-selected={mode === "sources"}
            onClick={() => setMode("sources")}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-bold transition ${mode === "sources" ? "bg-red-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            Linkuri & Embed
          </button>
          <button
            role="tab"
            aria-selected={mode === "m3u"}
            onClick={() => setMode("m3u")}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-bold transition ${mode === "m3u" ? "bg-red-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            Playlist M3U / IPTV
          </button>
        </div>

        {mode === "sources" ? (
          <>
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
                      <> • <b>{detected.providerLabel}</b> • redare: {detected.kind === "iframe" ? "iframe embed" : detected.kind === "video" ? "player nativ" : detected.kind === "hls" ? "HLS adaptiv" : detected.kind === "dash" ? "DASH adaptiv" : detected.kind === "ts" ? "MPEG-TS (mpegts.js)" : detected.kind === "unplayable" ? `protocol ${detected.protocol.toUpperCase()} — player extern (VLC)` : detected.kind === "html" ? "embed sandboxat" : "iframe generic"}</>
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

            {/* ---------- FAZA 10: ACCES SECURIZAT (token/HMAC/JWT) ---------- */}
            {lines.length <= 1 && (
              <details className="rounded-lg border border-zinc-800 bg-zinc-900/60" open={secOn}>
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-bold text-zinc-300">
                  <span>🔐 Acces securizat (token / HMAC / JWT)</span>
                  <button
                    type="button"
                    aria-label="Comută semnarea"
                    onClick={(e) => { e.preventDefault(); setSecOn((v) => !v); }}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${secOn ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400"}`}
                  >
                    {secOn ? "ACTIV" : "OFF"}
                  </button>
                </summary>
                {secOn && (
                  <div className="space-y-2 px-3 pb-3">
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                      Pentru streamuri directe protejate (MP4/HLS/DASH/MPEG-TS). Secretul se salvează
                      în Neon și NU ajunge niciodată în browser — la redare, serverul semnează URL-ul.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={secType}
                        onChange={(e) => setSecType(e.target.value)}
                        aria-label="Schema de semnare"
                        className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200"
                      >
                        <option value="query">Query token (?token=secret)</option>
                        <option value="hmac-md5">HMAC-MD5 (Wowza/Flussonic)</option>
                        <option value="hmac-sha256">HMAC-SHA256</option>
                        <option value="jwt">JWT HS256</option>
                      </select>
                      <Input
                        value={secParam}
                        onChange={(e) => setSecParam(e.target.value)}
                        placeholder="Parametru (token / st / auth)"
                        className="h-9 border-zinc-800 bg-zinc-950 text-xs"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="password"
                        value={secSecret}
                        onChange={(e) => setSecSecret(e.target.value)}
                        placeholder="Secret (min. 4 caractere)"
                        className="h-9 border-zinc-800 bg-zinc-950 text-xs"
                      />
                      <Input
                        value={secTtl}
                        onChange={(e) => setSecTtl(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="TTL secunde (300)"
                        className="h-9 border-zinc-800 bg-zinc-950 text-xs"
                      />
                    </div>
                  </div>
                )}
              </details>
            )}

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
              fallback extern. MPEG-TS (.ts) se redă prin mpegts.js; SRT/RTMP/UDP primesc instrucțiuni
              de restream + copiere URL. Aceleași linkuri adăugate repetat nu se dublează (idempotent).
            </p>
          </>
        ) : (
          <>
            <p className="-mt-1 text-xs text-zinc-500">
              Importă un <b className="text-zinc-300">playlist M3U / M3U8</b> (IPTV, canale TV, radio):
              lipește conținutul sau dă un URL de playlist. Se citesc automat <b className="text-zinc-300">tvg-logo</b>,
              <b className="text-zinc-300"> group-title</b> (categorii multiple separate prin „;”), calitatea
              (ex: 1080p) și steagurile [Geo-blocked] / [Not 24/7]. Importul e idempotent — re-importul
              aceluiași playlist nu se dublează.
            </p>

            <Input
              value={m3uUrl}
              onChange={(e) => setM3uUrl(e.target.value)}
              placeholder="URL playlist (opțional, ex: https://exemplu.tv/playlist.m3u)"
              className="border-zinc-800 bg-zinc-900 font-mono text-xs"
            />

            <textarea
              value={m3uText}
              onChange={(e) => setM3uText(e.target.value)}
              placeholder={"#EXTM3U\n#PLAYLIST:Canalele mele\n#EXTINF:-1 tvg-id=\"Canal.ro\" tvg-logo=\"https://.../logo.png\" group-title=\"Știri;RO;Generalist\",Canalul Meu (1080p)\nhttps://stream.exemplu.tv/live/index.m3u8"}
              rows={7}
              className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-600/50"
            />

            {m3uPreview && (
              <div className={`rounded-lg px-3 py-2 text-xs ring-1 ${
                m3uPreview.channels > 0
                  ? "bg-emerald-500/10 text-emerald-300 ring-emerald-600/30"
                  : "bg-red-500/10 text-red-300 ring-red-600/30"
              }`}>
                {m3uPreview.channels > 0 ? (
                  <div className="space-y-1">
                    <div>
                      ✓ <b>{m3uPreview.channels}</b> canale detectate{m3uPreview.radio > 0 && <> • <b>{m3uPreview.radio}</b> radio</>}
                      {m3uPreview.playlistName && <> • playlist „{m3uPreview.playlistName}"</>}
                    </div>
                    {m3uPreview.topGroups.length > 0 && (
                      <div className="text-emerald-400/80">
                        Grupuri: {m3uPreview.topGroups.map(([g, n]) => `${g} (${n})`).join(" • ")}
                      </div>
                    )}
                    {m3uPreview.sample.length > 0 && (
                      <div className="truncate text-emerald-400/60">Ex: {m3uPreview.sample.join(" • ")}</div>
                    )}
                  </div>
                ) : (
                  <>{m3uPreview.errors[0] || "Niciun canal detectat — verifică formatul"}</>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={importM3U}
                disabled={importing}
                className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50 transition"
              >
                {importing
                  ? "Se importă în Neon..."
                  : m3uPreview && m3uPreview.channels > 0
                    ? `Importă ${m3uPreview.channels} canale în biblioteca Neon`
                    : "Importă playlist în biblioteca Neon"}
              </button>
              <button
                onClick={reset}
                className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800 transition"
              >
                Curăță
              </button>
            </div>
            <p className="text-[11px] text-zinc-600">
              Limită: 20.000 canale per import (playlisturi mari — împarte-le). Canalele apar instant în
              meniurile TV Live / Radio, în căutare și în AI. Grupurile devin categorii filtrabile.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
