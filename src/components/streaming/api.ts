"use client";

// Helperi de fetch pentru API-urile interne
async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
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
  user: <T>(kind: string) => get<T>(`/api/user?kind=${kind}`),
  userPost: <T>(body: unknown) => post<T>("/api/user", body),
  subtitles: <T>(query: string) => get<T>(`/api/subtitles?${query}`),
};
