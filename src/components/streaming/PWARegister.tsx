"use client";

import { useEffect } from "react";

/**
 * Faza 13 — înregistrarea Service Worker-ului pentru PWA.
 * • înregistrare la „load” (nu blochează First Paint / TTI)
 * • „?nosw” → auto-unregister (escap de depanare)
 * • silent-fail: PWA nu trebuie să rupă niciodată aplicația
 */
export function PWARegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const swSupported = window.isSecureContext || window.location.hostname === "localhost";
    if (!swSupported) return;

    if (window.location.search.includes("nosw")) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      return;
    }

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* PWA best-effort — erorile de înregistrare nu afectează UX-ul */
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
