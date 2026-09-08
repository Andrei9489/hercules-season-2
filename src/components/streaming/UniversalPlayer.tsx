"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import type { ResolvedSource } from "@/lib/source-resolver";

type Props = {
  source: ResolvedSource;
  title: string;
  contentId?: number | null;
  compact?: boolean;
  /** URL semnat server-side (token/HMAC/JWT) — când există, înlocuiește src. */
  signedSrc?: string | null;
  /** Semnarea în curs (se cere /api/stream/sign). */
  signing?: boolean;
  /** FAZA 11 — reluare de la poziție (secunde). Aplicată pe video/HLS/DASH VOD
   *  + parametru „start” pe embed-urile YouTube; ignorată pe streamuri live. */
  startAt?: number;
  /** poziția curentă în timp real (pt. salvare precisă a progresului) */
  onTimeUpdate?: (seconds: number) => void;
  /** durata reală a mediaului (0/necunoscut pentru embed-uri) */
  onDuration?: (seconds: number) => void;
};

/**
 * Player universal: redă din orice sursă —
 *  iframe (YouTube/Vimeo/Dailymotion/ok.ru/Rumble/Twitch/etc.),
 *  video nativ (MP4/WebM), HLS (hls.js), DASH (dash.js),
 *  MPEG-TS (mpegts.js), HTML embed sandoboxat, sursă necunoscută →
 *  iframe generic + fallback extern; protocoale non-HTTP (SRT/RTMP/
 *  UDP/RTSP) → mesaj clar + copiere URL (browserele nu le pot reda).
 */
export function UniversalPlayer({ source, title, contentId, compact, signedSrc, signing, startAt = 0, onTimeUpdate, onDuration }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const eventTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const seconds = useRef(0);
  const seeked = useRef(false);

  // FAZA 11 — reluare de la poziție: la încărcarea metadatelor, sărim la startAt
  // (doar pentru conținut VOD — durată finită; streamurile live nu se pot „relua”)
  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    if (onDuration) onDuration(Number.isFinite(v.duration) ? v.duration : 0);
    if (!seeked.current && startAt > 10 && Number.isFinite(v.duration) && v.duration > 0 && startAt < v.duration - 5) {
      seeked.current = true;
      try { v.currentTime = startAt; } catch { /* some streams reject seeking */ }
    }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (onTimeUpdate && v) onTimeUpdate(v.currentTime);
  };

  // resetăm „reluat” la schimbarea sursei — fiecare item începe un nou ciclu de reluare
  useEffect(() => { seeked.current = false; }, [source, signedSrc]);

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

  // HLS prin hls.js (import dinamic) — suportă și URL semnat server-side
  useEffect(() => {
    if (source.kind !== "hls") return;
    const src = signedSrc || source.src;
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
          engine.loadSource(src);
          engine.attachMedia(video);
          engine.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setMediaError("Streamul HLS nu poate fi redat momentan.");
          });
          hls = engine;
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src; // Safari nativ
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
  }, [source, signedSrc]);

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

  // MPEG-TS prin mpegts.js (import dinamic) — streamuri .ts directe
  useEffect(() => {
    if (source.kind !== "ts") return;
    const src = signedSrc || source.src;
    let destroyed = false;
    type TsPlayer = { destroy: () => void; unload: () => void; attachMediaElement: (el: HTMLVideoElement) => void; load: () => void; play: () => void };
    let player: TsPlayer | null = null;
    (async () => {
      try {
        const mod = await import("mpegts.js");
        const mpegts = (mod as unknown as { default?: typeof import("mpegts.js") }).default ?? mod;
        const video = videoRef.current;
        if (!video || destroyed) return;
        if (!mpegts.getFeatureList().mseLivePlayback) {
          setMediaError("Browserul nu suportă redare MPEG-TS (MSE lipsă).");
          return;
        }
        const p = mpegts.createPlayer(
          { type: "mpegts", isLive: true, url: src },
          { enableWorker: true, enableStashBuffer: false, liveBufferLatencyChasing: true }
        );
        p.attachMediaElement(video);
        p.load();
        p.play().catch(() => {});
        p.on(mpegts.Events.ERROR, () => {
          if (!destroyed) setMediaError("Streamul MPEG-TS nu poate fi redat momentan.");
        });
        player = p as unknown as TsPlayer;
      } catch {
        if (!destroyed) setMediaError("Nu am putut încărca motorul MPEG-TS.");
      }
    })();
    return () => {
      destroyed = true;
      try { player?.unload(); player?.destroy(); } catch { /* ignore */ }
    };
  }, [source, signedSrc]);

  const outer = compact ? "h-full w-full" : "absolute inset-0 h-full w-full";

  // ---------- Protocoale non-HTTP: SRT / RTMP / RTSP / UDP ----------
  // Browserele NU pot deschide aceste transporturi (UDP/non-HTTP).
  // Oferim mesaj clar + copiere URL pentru player extern (VLC/ffplay)
  // — fără iframe spart, fără eroare confuză.
  if (source.kind === "unplayable") {
    const copy = () => {
      try {
        void navigator.clipboard.writeText(source.url);
      } catch { /* clipboard blocat — utilizatorul vede URL-ul */ }
    };
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <ShieldAlert className="h-9 w-9 text-amber-400" />
        <p className="text-sm font-bold text-zinc-200">Protocol {source.protocol.toUpperCase()} — necesită player extern</p>
        <p className="max-w-md text-xs leading-relaxed text-zinc-400">
        Browserul nu poate deschide transporturi {source.protocol.toUpperCase()} (non-HTTP).
        Restreamază sursa în HLS/DASH (ex: MediaMTX, nginx-rtmp, ffmpeg) pentru redare web
        sau deschide direct în VLC / ffplay.
        </p>
        <code className="max-w-full truncate rounded bg-zinc-900 px-3 py-1.5 text-[11px] text-zinc-300">{source.url}</code>
        <div className="flex gap-2">
          <button onClick={copy} className="rounded bg-zinc-800 px-4 py-2 text-xs font-bold text-zinc-100 hover:bg-zinc-700">Copiază URL</button>
          <a href={source.url} onClick={(e) => e.preventDefault()} className="pointer-events-none rounded bg-zinc-900 px-4 py-2 text-xs text-zinc-500">Deschide extern (VLC)</a>
        </div>
      </div>
    );
  }

  if (source.kind === "video" || source.kind === "hls" || source.kind === "dash" || source.kind === "ts") {
    return (
      <div className={outer}>
        {signing ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-red-600" />
          </div>
        ) : mediaError ? (
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
            src={source.kind === "video" ? (signedSrc || source.src) : undefined}
            controls
            autoPlay
            playsInline
            className="h-full w-full bg-black"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
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
  // FAZA 11 — YouTube acceptă reluarea prin parametrul „start”
  let src = source.kind === "iframe" ? source.src : source.kind === "unknown" ? source.url : "";
  if (src && startAt > 10 && /youtube[^/]*\.com\/embed\//i.test(src) && !/[?&]start=/i.test(src)) {
    src += `${src.includes("?") ? "&" : "?"}start=${Math.floor(startAt)}`;
  }
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
