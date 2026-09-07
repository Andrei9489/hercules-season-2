"use client";

import { useEffect } from "react";

// Afișează butonul "sus" când utilizatorul a derulat mult
export function ScrollTop() {
  useEffect(() => {
    const onScroll = () => {
      const btn = document.getElementById("scroll-top-btn");
      if (!btn) return;
      btn.style.opacity = window.scrollY > 600 ? "1" : "0";
      btn.style.pointerEvents = window.scrollY > 600 ? "auto" : "none";
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      id="scroll-top-btn"
      aria-label="Înapoi sus"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className="fixed bottom-5 right-5 z-40 h-11 w-11 rounded-full bg-red-600 text-white shadow-lg transition-opacity duration-300 opacity-0 pointer-events-none hover:bg-red-500"
    >
      ↑
    </button>
  );
}
