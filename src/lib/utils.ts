import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Faza 39 — extrage un mesaj de eroare UMAN din orice obiect aruncat
 * (Error, Neon/Postgres error, string, obiect oarecare). Niciodată
 * „[object Object]" în răspunsurile API sau în loguri.
 */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.name;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts = [o.message, o.reason, o.detail, o.code].filter(
      (x): x is string => typeof x === "string" && x.length > 0
    );
    if (parts.length) return parts.join(" · ");
    try { return JSON.stringify(e).slice(0, 300); } catch { /* ciclic */ }
  }
  return String(e ?? "eroare necunoscută");
}
