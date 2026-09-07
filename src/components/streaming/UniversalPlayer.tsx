"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import type { ResolvedSource } from "@/lib/source-resolver";

type Props = {
  source: ResolvedSource;
  title: string;
  contentId?: number | null;
  compact?: boolean;
};

/**
 * Player universal: redă din orice sursă —
 *  iframe (YouTube/Vimeo/Dailymotion/ok.ru/Rumble/Twitch/etc.),
 *  video nativ (MP4/WebM), HLS (hls.js), DASH (dash.js), HTML embed
 *  sandoboxat, sursă necunoscută → iframe generic + fallback extern.
 */
export function UniversalPlayer({ source, title, contentId, compact }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const eventTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const seconds = useRef(0);

  // evenimente de redare → Neon (asincron)
  useEffect(() => {
    if (!contentId) return;
    seconds.current = 0;
    try {
      fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "play_event", contentId, provider: source.provider, event: "start", seconds: 0 }),
      }).catch(() => {});
    } catch { /* ignore */ }
    eventTimer.current = setInterval(() => {
      seconds.current += 30;
      try {
        fetch("/api/library", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "play_event", contentId, provider: source.provider, event: "heartbeat", seconds: seconds.current }),
        }).catch(() => {});
      } catch { /* ignore */ }
    }, 30_000);
    return () => {
      if (eventTimer.current) clearInterval(eventTimer.current);
      if (!contentId || seconds.current < 5) return;
      try {
        fetch("/api/library", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({ action: "play_event", contentId, provider: source.provider, event: "complete", seconds: seconds.current }),
        }).catch(() => {});
      } catch { /* ignore */ }
    };
  }, [contentId, source.provider]);

  // HLS prin hls.js (import dinamic)
  useEffect(() => {
    if (source.kind !== "hls") return;
    let destroyed = false;
    let hls: { destroy: () => void } | null = null;
    (async () => {
      try {
        const mod = await import("hls.js");
        const Hls = mod.default;
        const video = videoRef.current;
        if (!video) return;
        if (Hls.isSupported()) {
          const engine = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 30 });
          engine.loadSource(source.src);
          engine.attachMedia(video);
          engine.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setMediaError("Streamul HLS nu poate fi redat momentan.");
          });
          hls = engine;
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = source.src; // Safari nativ
        } else {
          setMediaError("HLS nu este suportat în acest browser.");
        }
      } catch {
        if (!destroyed) setMediaError("Nu am putut încărca motorul HLS.");
      }
    })();
    return () => {
      destroyed = true;
      if (hls) hls.destroy();
    };
  }, [source]);

  // DASH prin dash.js (import dinamic) — canale .mpd (BBC, Polsat etc.)
  useEffect(() => {
    if (source.kind !== "dash") return;
    let destroyed = false;
    let player: { reset: () => void; destroy?: () => void } | null = null;
    type DashPlayer = {
      initialize: (el: HTMLVideoElement, url: string, autoPlay?: boolean) => void;
      reset: () => void;
      destroy?: () => void;
    };
    (async () => {
      try {
        const mod = (await import("dashjs")) as unknown as {
          default?: { MediaPlayer: () => { create: () => DashPlayer } };
          MediaPlayer?: () => { create: () => DashPlayer };
        };
        const dashjs = mod.default ?? mod;
        const video = videoRef.current;
        if (!video || destroyed) return;
        const p = dashjs.MediaPlayer().create();
        p.initialize(video, source.src, true);
        player = p;
      } catch {
        if (!destroyed) setMediaError("Nu am putut încărca motorul DASH.");
      }
    })();
    return () => {
      destroyed = true;
      try { player?.reset(); player?.destroy?.(); } catch { /* ignore */ }
    };
  }, [source]);

  const outer = compact ? "h-full w-full" : "absolute inset-0 h-full w-full";

  if (source.kind === "video" || source.kind === "hls" || source.kind === "dash") {
    return (
      <div className={outer}>
        {mediaError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <ShieldAlert className="h-8 w-8 text-amber-400" />
            <p className="text-sm text-zinc-400">{mediaError}</p>
            <a href={source.src} target="_blank" rel="noreferrer" className="rounded bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-500">
              Deschide streamul în tab nou
            </a>
          </div>
        ) : (
          <video
            ref={videoRef}
            src={source.kind === "video" ? source.src : undefined}
            controls
            autoPlay
            playsInline
            className="h-full w-full bg-black"
            onError={() => setMediaError("Fișierul media nu poate fi redat (format sau CORS nesuportat).")}
          />
        )}
      </div>
    );
  }

  if (source.kind === "html") {
    // cod embed (iframe/script) — sandoboxat în origin opac
    return (
      <iframe
        srcDoc={source.html}
        title={title}
        sandbox="allow-scripts allow-popups allow-forms allow-presentation"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        className={outer}
      />
    );
  }

  // iframe (provider recunoscut sau necunoscut) + fallback
  const src = source.kind === "iframe" ? source.src : source.kind === "unknown" ? source.url : "";
  if (!src) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-500">
        Sursa nu are un link de redare valid.
      </div>
    );
  }

  return (
    <div className={outer}>
      {fallback && !compact && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-amber-500/90 px-3 py-1.5 text-[11px] font-semibold text-black">
          <span className="flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5" />
            Dacă sursa blochează încorporarea (X-Frame-Options), folosește butonul de deschidere externă.
          </span>
          <button aria-label="Ascunde" className="underline" onClick={() => setFallback(false)}>ascunde</button>
        </div>
      )}
      <iframe
        src={src}
        title={title}
        referrerPolicy="origin"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; clipboard-write"
        allowFullScreen
        className="h-full w-full border-0 bg-black"
        onError={() => setFallback(true)}
      />
      {!compact && (
        <div className="absolute bottom-2 right-2 z-10 flex items-center gap-2">
          <a
            href={source.kind === "unknown" ? source.url : src}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 backdrop-blur transition hover:bg-black/90"
          >
            <ExternalLink className="h-3 w-3" /> Deschide sursa extern
          </a>
        </div>
      )}
    </div>
  );
}
