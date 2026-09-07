// ============================================================
// Resolver universal de surse StreamVerse — recunoaște URL-uri
// și coduri embed (iframe/embed/object/video/script) din orice
// platformă: YouTube, Vimeo, Dailymotion, ok.ru, Rumble, Twitch,
// TikTok, Facebook, VK, Streamable, Drive, Odysee, BitChute,
// Bilibili, Archive.org, TED, SoundCloud, Spotify, MP4/HLS direct,
// surse necunoscute → fallback iframe generic.
// Fără API-uri DOM — funcționează pe server și client.
// ============================================================

export type ResolvedSource =
  | { kind: "iframe"; src: string; provider: string; providerLabel: string }
  | { kind: "video"; src: string; provider: string; providerLabel: string }
  | { kind: "hls"; src: string; provider: string; providerLabel: string }
  | { kind: "dash"; src: string; provider: string; providerLabel: string }
  | { kind: "html"; html: string; provider: string; providerLabel: string }
  | { kind: "unknown"; url: string; provider: string; providerLabel: string };

export const PROVIDER_LABELS: Record<string, string> = {
  youtube: "YouTube", vimeo: "Vimeo", dailymotion: "Dailymotion", "ok-ru": "OK.ru",
  rumble: "Rumble", twitch: "Twitch", tiktok: "TikTok", facebook: "Facebook",
  vk: "VK", streamable: "Streamable", gdrive: "Google Drive", odysee: "Odysee",
  bitchute: "BitChute", bilibili: "Bilibili", archive: "Archive.org", ted: "TED",
  soundcloud: "SoundCloud", spotify: "Spotify", mixcloud: "Mixcloud",
  direct: "MP4/WebM direct", hls: "HLS (m3u8)", dash: "DASH (mpd)", embed: "Embed cod", unknown: "Sursă externă",
};

const DIRECT_RE = /\.(mp4|webm|ogg|ogv|mov|m4v|mp3|m4a|wav)(\?.*)?$/i;
const HLS_RE = /\.m3u8(\?.*)?$/i;
const DASH_RE = /\.mpd(\?.*)?$/i;

function label(p: string): string {
  return PROVIDER_LABELS[p] || p;
}

/** Extrage prima sursă dintr-un cod embed HTML (iframe/embed/object/video/audio/source/blockquote). */
export function parseEmbedCode(code: string): string | null {
  const m =
    /<iframe[^>]+src\s*=\s*["']([^"']+)["']/i.exec(code) ||
    /<embed[^>]+src\s*=\s*["']([^"']+)["']/i.exec(code) ||
    /<object[^>]+data\s*=\s*["']([^"']+)["']/i.exec(code) ||
    /<video[^>]+src\s*=\s*["']([^"']+)["']/i.exec(code) ||
    /<audio[^>]+src\s*=\s*["']([^"']+)["']/i.exec(code) ||
    /<source[^>]+src\s*=\s*["']([^"']+)["']/i.exec(code) ||
    /<blockquote[^>]+class\s*=\s*["'][^"']*(twitter-tweet|instagram-media)[^"']*["'][^>]*>/i.exec(code) ||
    /data-(?:video|embed|url)\s*=\s*["']([^"']+)["']/i.exec(code);
  if (m && m[1]) return m[1];
  // script embed (ex: Rumble/Odysee widget) — se redă ca HTML sandoboxat
  if (/<script|<iframe|<video|<object|<blockquote/i.test(code)) return "__RAW_HTML__";
  return null;
}

/** Transformă un URL de vizionare în URL de embed/redare. */
export function resolveUrl(rawUrl: string, opts: { parent?: string } = {}): ResolvedSource {
  const url = rawUrl.trim();
  const lower = url.toLowerCase();
  const parent = opts.parent || "";

  // ---------- Fișiere directe ----------
  if (HLS_RE.test(lower)) {
    return { kind: "hls", src: url, provider: "hls", providerLabel: label("hls") };
  }
  if (DASH_RE.test(lower)) {
    return { kind: "dash", src: url, provider: "dash", providerLabel: label("dash") };
  }
  if (DIRECT_RE.test(lower)) {
    return { kind: "video", src: url, provider: "direct", providerLabel: label("direct") };
  }

  // ---------- YouTube ----------
  let m =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([\w-]{6,})/i.exec(url);
  if (m) {
    const t = /(?:\?|&)(?:t|start)=(\d+)/i.exec(url);
    const tParam = t ? `&start=${t[1]}` : "";
    return {
      kind: "iframe",
      src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0${tParam}`,
      provider: "youtube", providerLabel: label("youtube"),
    };
  }
  m = /youtube\.com\/playlist\?list=([\w-]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://www.youtube-nocookie.com/embed/videoseries?list=${m[1]}`,
      provider: "youtube", providerLabel: label("youtube"),
    };
  }

  // ---------- Vimeo ----------
  m = /vimeo\.com\/(?:video\/)?(\d+)(?:\/([\w]+))?/i.exec(url);
  if (m) {
    const h = m[2] ? `?h=${m[2]}` : "";
    return {
      kind: "iframe",
      src: `https://player.vimeo.com/video/${m[1]}${h}`,
      provider: "vimeo", providerLabel: label("vimeo"),
    };
  }

  // ---------- Dailymotion ----------
  m = /(?:dailymotion\.com\/(?:video\/|embed\/video\/)|dai\.ly\/)([a-z0-9]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://geo.dailymotion.com/player.html?video=${m[1]}`,
      provider: "dailymotion", providerLabel: label("dailymotion"),
    };
  }

  // ---------- OK.ru ----------
  m = /ok\.ru\/(?:video|live)\/(\d+|[a-z0-9]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://ok.ru/videoembed/${m[1]}`,
      provider: "ok-ru", providerLabel: label("ok-ru"),
    };
  }

  // ---------- Rumble ----------
  m = /rumble\.com\/(?:embed\/)?(?:v([a-z0-9]+)(?:-[^\/?#]*)?)/i.exec(url);
  if (m) {
    const pub = /pub=\w+/i.exec(url);
    return {
      kind: "iframe",
      src: `https://rumble.com/embed/v${m[1]}/${pub ? `?${pub[0]}` : ""}`,
      provider: "rumble", providerLabel: label("rumble"),
    };
  }

  // ---------- Twitch ----------
  m = /twitch\.tv\/videos\/(\d+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://player.twitch.tv/?video=v${m[1]}&parent=${parent}&autoplay=true`,
      provider: "twitch", providerLabel: label("twitch"),
    };
  }
  m = /twitch\.tv\/([a-z0-9_]{3,})/i.exec(url);
  if (m && !lower.includes("/videos/")) {
    return {
      kind: "iframe",
      src: `https://player.twitch.tv/?channel=${m[1]}&parent=${parent}&autoplay=true`,
      provider: "twitch", providerLabel: label("twitch"),
    };
  }

  // ---------- TikTok ----------
  m = /tiktok\.com\/.*\/video\/(\d+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://www.tiktok.com/embed/v2/${m[1]}`,
      provider: "tiktok", providerLabel: label("tiktok"),
    };
  }

  // ---------- Facebook / FB.watch ----------
  if (/facebook\.com|fb\.watch/i.test(url)) {
    return {
      kind: "iframe",
      src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false&autoplay=true`,
      provider: "facebook", providerLabel: label("facebook"),
    };
  }

  // ---------- VK ----------
  m = /vk\.com\/video(-?\d+)_(\d+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://vk.com/video_ext.php?oid=${m[1]}&id=${m[2]}&autoplay=1`,
      provider: "vk", providerLabel: label("vk"),
    };
  }

  // ---------- Streamable ----------
  m = /streamable\.com\/(?:e\/)?([a-z0-9]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://streamable.com/e/${m[1]}?autoplay=1`,
      provider: "streamable", providerLabel: label("streamable"),
    };
  }

  // ---------- Google Drive ----------
  m = /drive\.google\.com\/file\/d\/([\w-]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://drive.google.com/file/d/${m[1]}/preview`,
      provider: "gdrive", providerLabel: label("gdrive"),
    };
  }

  // ---------- Archive.org ----------
  m = /archive\.org\/(?:details|embed)\/([^\/?#]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://archive.org/embed/${m[1]}`,
      provider: "archive", providerLabel: label("archive"),
    };
  }

  // ---------- Bilibili ----------
  m = /bilibili\.com\/video\/(BV[\w]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://player.bilibili.com/player.html?bvid=${m[1]}&autoplay=0`,
      provider: "bilibili", providerLabel: label("bilibili"),
    };
  }

  // ---------- Odysee ----------
  m = /odysee\.com\/(@[\w\-./]+)/i.exec(url);
  if (m) {
    const path = m[1].replace(/\/$/, "");
    return {
      kind: "iframe",
      src: `https://odysee.com/$/embed/${path}`,
      provider: "odysee", providerLabel: label("odysee"),
    };
  }

  // ---------- BitChute ----------
  m = /bitchute\.com\/(?:video|embed)\/([\w-]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://www.bitchute.com/embed/${m[1]}/`,
      provider: "bitchute", providerLabel: label("bitchute"),
    };
  }

  // ---------- TED ----------
  m = /ted\.com\/talks\/([\w-]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://embed.ted.com/talks/${m[1]}`,
      provider: "ted", providerLabel: label("ted"),
    };
  }

  // ---------- SoundCloud ----------
  if (/soundcloud\.com/i.test(url)) {
    return {
      kind: "iframe",
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=true&visual=true`,
      provider: "soundcloud", providerLabel: label("soundcloud"),
    };
  }

  // ---------- Mixcloud ----------
  if (/mixcloud\.com/i.test(url)) {
    return {
      kind: "iframe",
      src: `https://player-widget.mixcloud.com/widget/iframe/?feed=${encodeURIComponent(url)}&autoplay=true`,
      provider: "mixcloud", providerLabel: label("mixcloud"),
    };
  }

  // ---------- Spotify ----------
  m = /open\.spotify\.com\/(track|album|playlist|episode|show)\/([\w]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`,
      provider: "spotify", providerLabel: label("spotify"),
    };
  }

  // ---------- Instagram (post/reel) ----------
  m = /instagram\.com\/(?:p|reel|tv)\/([\w-]+)/i.exec(url);
  if (m) {
    return {
      kind: "iframe",
      src: `https://www.instagram.com/p/${m[1]}/embed/captioned/`,
      provider: "facebook", providerLabel: "Instagram",
    };
  }

  // ---------- Necunoscut → fallback iframe generic ----------
  if (/^https?:\/\//i.test(url)) {
    return { kind: "unknown", url, provider: "unknown", providerLabel: label("unknown") };
  }

  return { kind: "unknown", url: "", provider: "unknown", providerLabel: label("unknown") };
}

/** Rezolvă fie URL, fie cod embed complet. */
export function resolveSource(input: string, opts: { parent?: string } = {}): ResolvedSource | null {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;

  // cod embed HTML?
  if (trimmed.startsWith("<")) {
    const src = parseEmbedCode(trimmed);
    if (!src) return null;
    if (src === "__RAW_HTML__") {
      return { kind: "html", html: trimmed, provider: "embed", providerLabel: label("embed") };
    }
    const resolved = resolveUrl(src, opts);
    if (resolved.kind === "unknown" && /^https?:\/\//i.test(src)) {
      // iframe extern necunoscut — redăm direct URL-ul în iframe
      return { kind: "iframe", src, provider: "embed", providerLabel: label("embed") };
    }
    return resolved;
  }

  // URL cu protocol lipsă?
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return resolveUrl(withProto, opts);
}

/** Derivează titlu prietenos din URL când utilizatorul nu oferă unul. */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    // YouTube
    const yt = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{6,})/i.exec(url);
    if (yt) return `Video YouTube ${yt[1].slice(0, 8)}`;
    const seg = u.pathname.split("/").filter(Boolean).pop() || u.hostname.replace("www.", "");
    const clean = decodeURIComponent(seg)
      .replace(/\.(mp4|webm|ogg|ogv|mov|m4v|mp3|m4a|wav|m3u8|html?)$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (clean || u.hostname).slice(0, 90).replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "Conținut extern";
  }
}
