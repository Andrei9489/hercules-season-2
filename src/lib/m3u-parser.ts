// ============================================================
// Parser M3U/M3U8 ROBUST (Faza 9) — import de playlist-uri de
// utilizator în biblioteca Neon. Server-safe (fără API-uri DOM).
//
// Suportă:
//  • #EXTM3U / #PLAYLIST name
//  • #EXTINF:-1 tvg-id="..." tvg-logo="..." group-title="A;B;C",Nume
//    (group-title cu MAI MULTE categorii separate prin „;")
//  • marcaje de calitate în nume: (1080p), (720p), (HD), (SD)...
//  • steaguri [Geo-blocked] și [Not 24/7]
//  • linii URL directe (fără EXTINF) → titlu derivat din URL
//  • detecție radio (grupuri "Radio*" / extensii audio / .m3u8 radio)
// ============================================================

export type M3UChannel = {
  name: string;
  tvgId: string | null;
  logo: string | null;
  groups: string[];
  url: string;
  quality: string | null;
  geoBlocked: boolean;
  not247: boolean;
  isRadio: boolean;
};

export type M3UParseResult = {
  playlistName: string | null;
  channels: M3UChannel[];
  skipped: number; // linii non-media (VOD option, second URL pe același EXTINF etc.)
  errors: string[]; // mesaje de diagnostic (max 5)
};

const QUALITY_RE = /\((\d{3,4}p|4K|UHD|FHD|HD|SD|HQ|LQ)\)/i;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)(\?|$)/i;
const RADIO_GROUP_RE = /(^|[\s/|-])radio\b|\bradio[\s-]|fm\b|radio$/i;

/** Derivează un titlu citibil din URL pentru linii fără EXTINF. */
function titleFromUrl(u: string): string {
  try {
    const url = new URL(u);
    const seg = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
    const clean = decodeURIComponent(seg)
      .replace(/\.(m3u8?|mpd|ts|mp4|mp3|m4a|aac|flac|ogg)(\?.*)?$/i, "")
      .replace(/[-_+.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (clean || url.hostname).slice(0, 120).replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return u.slice(0, 100);
  }
}

/**
 * Parsează conținutul brut al unui playlist M3U/M3U8.
 * Tolerant la: BOM, linii goale, EXTINF fără virgulă, atribute duplictate,
 * URL-uri pe mai multe linii consecutive (ia primul valid per EXTINF).
 */
export function parseM3U(text: string): M3UParseResult {
  const errors: string[] = [];
  const warn = (m: string) => {
    if (errors.length < 5) errors.push(m);
  };

  // elimină BOM + normalizează linii
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim());

  let playlistName: string | null = null;
  const channels: M3UChannel[] = [];
  let skipped = 0;

  let pending: Partial<M3UChannel> | null = null;

  const isUrl = (s: string) => /^(https?|rtmp|rtsp|udp|srt):\/\//i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}([/?#]|$)/i.test(s);

  for (const raw of lines) {
    if (!raw) continue;

    if (raw.startsWith("#PLAYLIST:")) {
      playlistName = raw.slice(10).trim() || null;
      continue;
    }

    if (raw.startsWith("#EXTINF")) {
      // dacă EXTINF-ul anterior nu a primit URL → contorizează ca sărit
      if (pending) skipped++;

      const afterColon = raw.slice(raw.indexOf(":") + 1);
      const commaIdx = afterColon.indexOf(",");
      const attrPart = commaIdx >= 0 ? afterColon.slice(0, commaIdx) : afterColon;
      const displayName = commaIdx >= 0 ? afterColon.slice(commaIdx + 1).trim() : "";

      const attr = (name: string): string | null => {
        const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrPart) ||
                  new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i").exec(attrPart);
        return m && m[1] ? m[1].trim() : null;
      };

      const groups = (attr("group-title") || "")
        .split(/[;|]/)
        .map((g) => g.trim())
        .filter(Boolean);

      const name = displayName || attr("tvg-name") || "";

      pending = {
        name,
        tvgId: attr("tvg-id"),
        logo: attr("tvg-logo"),
        groups,
        quality: null,
        geoBlocked: false,
        not247: false,
        isRadio: false,
      };
      continue;
    }

    // alte directive #EXTVLCOPT, #EXTGRP, #KODIPROP etc. — ignorate
    if (raw.startsWith("#")) continue;

    // linie de media (URL)
    if (isUrl(raw)) {
      if (!pending) {
        // URL fără EXTINF — titlu din URL, fără metadate
        pending = { name: "", tvgId: null, logo: null, groups: [], quality: null, geoBlocked: false, not247: false, isRadio: false };
      }
      const name = pending.name || titleFromUrl(raw);
      const qm = QUALITY_RE.exec(name);
      const quality = qm ? qm[1].toUpperCase() : null;
      const geoBlocked = /\[geo[\s-]?blocked\]/i.test(name);
      const not247 = /\[not\s*24\/?7\]/i.test(name);
      const cleanName = name
        .replace(/\[(geo[\s-]?blocked|not\s*24\/?7)\]/gi, "")
        .replace(QUALITY_RE, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      const isRadio =
        AUDIO_EXT_RE.test(raw) ||
        pending.groups.some((g) => RADIO_GROUP_RE.test(g)) ||
        /^radio[\s:.-]/i.test(cleanName);

      channels.push({
        name: cleanName || titleFromUrl(raw),
        tvgId: pending.tvgId ?? null,
        logo: pending.logo ?? null,
        groups: pending.groups ?? [],
        url: raw,
        quality,
        geoBlocked,
        not247,
        isRadio,
      });
      pending = null;
      continue;
    }

    // linie nerecunoscută (HTML, text random)
    skipped++;
    if (channels.length === 0 && !raw.startsWith("#") && raw.length > 0) {
      // probabil că utilizatorul a lipit un HTML — avertizează clar
      if (/<html|<!doctype/i.test(raw)) warn("Conținutul pare a fi HTML, nu un playlist M3U.");
    }
  }

  if (pending) skipped++;
  if (channels.length === 0 && errors.length === 0) {
    warn("Nicio intrare media găsită — verifică formatul (#EXTINF + URL).");
  }

  return { playlistName, channels, skipped, errors };
}

/** Normalizează un URL de playlist primit de la utilizator. */
export function normalizeM3UInputUrl(u: string): string {
  const t = u.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}
