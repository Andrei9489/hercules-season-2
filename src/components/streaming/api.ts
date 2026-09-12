"use client";

// Helperi de fetch pentru API-urile interne
// Faza 39: erorile NU mai sunt opace — mesajul real din corpul răspunsului
// (câmpurile error/message) ajunge în exception, deci în toast-urile UI.
import { enqueueOfflineWrite } from "@/lib/sync-outbox";

/** Extrage mesajul real dintr-un răspuns de eroare JSON al serverului. */
async function apiError(res: Response): Promise<Error> {
  let detail = "";
  try {
    const j = (await res.json()) as { error?: unknown; message?: unknown };
    const e = typeof j?.error === "string" ? j.error : "";
    const m = typeof j?.message === "string" ? j.message : "";
    detail = [e, m].filter(Boolean).join(" — ");
  } catch { /* corp non-JSON */ }
  return new Error(detail ? `API ${res.status}: ${detail}` : `API ${res.status}`);
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

async function post<T>(url: string, body: unknown): Promise<T> {
  // FAZA 14 — Neon Sync: scrierile făcute OFFLINE intră în coada outbox
  // (localStorage) și ajung în Neon la prima sincronizare. Răspuns sintetic
  // „queued" pentru UI optimist; serverul aplică operațiunile idempotent.
  const writeUrl = url === "/api/user" || url === "/api/collections";
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  if (writeUrl && offline && typeof body === "object" && body !== null) {
    const synthetic = enqueueOfflineWrite(url, body as Record<string, unknown>);
    if (synthetic) return synthetic as T;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // rețea picată în timpul fetch-ului (trecere offline / drop) → outbox
    if (writeUrl && typeof body === "object" && body !== null) {
      const synthetic = enqueueOfflineWrite(url, body as Record<string, unknown>);
      if (synthetic) return synthetic as T;
    }
    throw err;
  }
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export const api = {
  get,
  post,
  tmdb: <T>(query: string) => get<T>(`/api/tmdb?${query}`),
  anime: <T>(query: string) => get<T>(`/api/anime?${query}`),
  tv: <T>(query: string) => get<T>(`/api/tv?${query}`),
  music: <T>(query: string) => get<T>(`/api/music?${query}`),
  sports: <T>(query: string) => get<T>(`/api/sports?${query}`),
  gaming: <T>(query: string) => get<T>(`/api/gaming?${query}`),
  kids: <T>(query: string) => get<T>(`/api/kids?${query}`),
  news: <T>(query: string) => get<T>(`/api/news?${query}`),
  fun: <T>(query: string) => get<T>(`/api/fun?${query}`),
  search: <T>(q: string) => get<T>(`/api/search?q=${encodeURIComponent(q)}`),
  searchMode: <T>(q: string, mode: string, limit = 24) =>
    get<T>(`/api/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=${limit}`),
  library: <T>(query: string) => get<T>(`/api/library${query ? `?${query}` : ""}`),
  libraryPost: <T>(body: unknown) => post<T>("/api/library", body),
  channels: <T>(query: string) => get<T>(`/api/channels${query ? `?${query}` : ""}`),
  status: <T>() => get<T>(`/api/status`),
  user: <T>(kind: string) => get<T>(`/api/user?kind=${kind}`),
  userPost: <T>(body: unknown) => post<T>("/api/user", body),
  subtitles: <T>(query: string) => get<T>(`/api/subtitles?${query}`),
  // Faza 7 — AI Intelligence Suite
  browse: <T>(query: string) => get<T>(`/api/browse?${query}`),
  aiAnalyzer: <T>() => get<T>(`/api/ai/analyzer`),
  aiAnalyzerRun: <T>() => post<T>("/api/ai/analyzer", {}),
  aiGenres: <T>() => get<T>(`/api/ai/genres`),
  aiGenresRun: <T>() => post<T>("/api/ai/genres", {}),
  aiMetadata: <T>() => get<T>(`/api/ai/metadata`),
  aiMetadataRun: <T>(maxTmdb = 300, llmBatches = 4) =>
    post<T>(`/api/ai/metadata?maxTmdb=${maxTmdb}&llmBatches=${llmBatches}`, {}),
  aiRecommend: <T>(query: string) => get<T>(`/api/ai/recommend?${query}`),
  // Faza 11 — colecții personale + mentenanță
  collections: <T>(query = "") => get<T>(`/api/collections${query ? `?${query}` : ""}`),
  collectionsPost: <T>(body: unknown) => post<T>("/api/collections", body),
  // Faza 16 — gestionare bibliotecă (postere/conținut/duplicate) + multi-region
  manage: <T>(query: string) => get<T>(`/api/manage${query ? `?${query}` : ""}`),
  managePost: <T>(body: unknown) => post<T>("/api/manage", body),
  regions: <T>(query = "") => get<T>(`/api/regions${query ? `?${query}` : ""}`),
};
