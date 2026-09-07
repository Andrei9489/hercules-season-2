"use client";

// ============================================================
// Faza 7 — CURSOR AI AUTOMAT (funcție ON/OFF)
// Un cursor virtual condus de AI care explorează singur platforma:
//  - alege ținte reale din pagină (carduri, meniuri, butoane safe)
//  - mișcare lină cu inerție + ripples la sosire
//  - hover cu highlight + citirea etichetei elementului
//  - click DOAR pe elemente marcate [data-ai-click] (carduri media)
//  - auto-scroll explorator prin pagină
// Comutator ON/OFF flotant, jos-dreapta. Fără localStorage —
// starea rămâne în sesiune (totul în Neon, nimic local).
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Power } from "lucide-react";

type Target = { x: number; y: number; label: string; el: HTMLElement | null };

function pickTarget(): Target | null {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cands = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-ai-click], main a[href], nav button, .group"
    )
  ).filter((el) => {
    if (el.closest("[data-ai-cursor-ignore]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 30 && r.height > 30 && r.bottom > 60 && r.top < h - 10 && r.right > 0 && r.left < w;
  });
  if (cands.length === 0) return null;
  const el = cands[Math.floor(Math.random() * cands.length)];
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2 + (Math.random() - 0.5) * Math.min(40, r.width * 0.3),
    y: r.top + r.height / 2 + (Math.random() - 0.5) * Math.min(40, r.height * 0.3),
    label: (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "element")
      .trim()
      .slice(0, 48),
    el,
  };
}

export function AICursor() {
  const [on, setOn] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [label, setLabel] = useState("");
  const [action, setAction] = useState<"idle" | "travel" | "hover" | "click">("idle");
  const [stats, setStats] = useState({ moves: 0, clicks: 0 });
  const rafRef = useRef(0);
  const cur = useRef({ x: -100, y: -100 });
  const tgt = useRef<Target | null>(null);
  const waitUntil = useRef(0);
  const hlEl = useRef<HTMLElement | null>(null);

  const clearHighlight = useCallback(() => {
    if (hlEl.current) {
      hlEl.current.style.outline = "";
      hlEl.current.style.outlineOffset = "";
      hlEl.current.style.borderRadius = "";
      hlEl.current = null;
    }
  }, []);

  useEffect(() => {
    if (!on) {
      cancelAnimationFrame(rafRef.current);
      clearHighlight();
      return;
    }

    let prevT = performance.now();

    const loop = (t: number) => {
      const dt = Math.min(64, t - prevT);
      prevT = t;

      // alegem țintă nouă după pauză
      if (!tgt.current && t > waitUntil.current) {
        const nt = pickTarget();
        if (nt) {
          tgt.current = nt;
          setAction("travel");
          setLabel(nt.label);
          setStats((s) => ({ ...s, moves: s.moves + 1 }));
        } else {
          waitUntil.current = t + 1500;
        }
      }

      if (tgt.current) {
        const dx = tgt.current.x - cur.current.x;
        const dy = tgt.current.y - cur.current.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 6) {
          // SOSIRE — hover + highlight + uneori click pe elemente safe
          cur.current.x = tgt.current.x;
          cur.current.y = tgt.current.y;
          setAction("hover");
          const el = tgt.current.el;
          if (el && hlEl.current !== el) {
            clearHighlight();
            el.style.outline = "2px solid #f43f5e";
            el.style.outlineOffset = "2px";
            el.style.borderRadius = "10px";
            hlEl.current = el;
          }
          if (el && el.hasAttribute("data-ai-click") && !el.closest("dialog")) {
            setAction("click");
            setStats((s) => ({ ...s, clicks: s.clicks + 1 }));
            el.click();
          }
          const dwell = 1400 + Math.random() * 2200;
          waitUntil.current = t + dwell;
          tgt.current = null;
        } else {
          // mișcare lină (easing inerțial)
          const speed = Math.min(dist, 9 + dist * 0.09) * (dt / 16.7);
          cur.current.x += (dx / dist) * speed;
          cur.current.y += (dy / dist) * speed;
        }
        setPos({ x: cur.current.x, y: cur.current.y });
      } else {
        // drift explorator + auto-scroll ocazional
        if (Math.random() < 0.006 * (dt / 16.7)) {
          window.scrollBy({ top: (Math.random() - 0.35) * 420, behavior: "smooth" });
        }
        cur.current.x += Math.sin(t / 900) * 0.7;
        cur.current.y += Math.cos(t / 1100) * 0.7;
        setPos({ x: cur.current.x, y: cur.current.y });
      }

      // clear highlight la plecare
      if (!tgt.current && hlEl.current && t > waitUntil.current - 300) clearHighlight();

      rafRef.current = requestAnimationFrame(loop);
    };

    // pornim din centrul ecranului
    if (cur.current.x < 0) {
      cur.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }
    waitUntil.current = performance.now() + 600;
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearHighlight();
    };
  }, [on, clearHighlight]);

  return (
    <>
      {/* cursor virtual + etichetă */}
      {on && pos && (
        <div className="pointer-events-none fixed inset-0 z-[9999]" aria-hidden="true">
          <div
            className="absolute transition-none"
            style={{ left: pos.x, top: pos.y, transform: "translate(-50%,-50%)" }}
          >
            <div
              className={`relative flex h-7 w-7 items-center justify-center rounded-full border-2 shadow-lg ${
                action === "click"
                  ? "border-white bg-red-600 scale-125"
                  : action === "hover"
                    ? "border-red-500 bg-red-600/90 scale-110"
                    : "border-red-400/80 bg-red-600/50"
              } transition-transform duration-150`}
            >
              <Bot className="h-3.5 w-3.5 text-white" />
              {action === "travel" && (
                <span className="absolute inset-0 animate-ping rounded-full bg-red-500/40" />
              )}
            </div>
            {label && (
              <div className="absolute left-9 top-0 max-w-[220px] truncate rounded-lg bg-black/85 px-2.5 py-1 text-[11px] font-medium text-zinc-100 ring-1 ring-red-500/40">
                AI: {label}
              </div>
            )}
          </div>
        </div>
      )}

      {/* comutator ON/OFF flotant */}
      <div
        data-ai-cursor-ignore
        className="fixed bottom-4 right-4 z-[9998] flex items-center gap-2.5 rounded-2xl bg-black/85 px-3.5 py-2.5 ring-1 ring-red-600/40 backdrop-blur"
      >
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5 text-[12px] font-bold text-zinc-100">
            <Bot className="h-3.5 w-3.5 text-red-500" /> Cursor AI
          </span>
          <span className="text-[10px] text-zinc-500">
            {on
              ? `ON • ${stats.moves} > explorare automată (${stats.clicks} deschise)`
              : "OFF • activează explorarea automată"}
          </span>
        </div>
        <button
          onClick={() => {
            if (on) {
              // la oprire: resetăm vizualizarea aici (nu în efect)
              setPos(null);
              setLabel("");
              setAction("idle");
            }
            setOn((v) => !v);
          }}
          aria-pressed={on}
          aria-label={on ? "Oprește cursorul AI" : "Pornește cursorul AI"}
          className={`relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors ${
            on ? "bg-red-600" : "bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-white transition-all ${
              on ? "left-[22px]" : "left-0.5"
            }`}
          >
            <Power className={`h-3 w-3 ${on ? "text-red-600" : "text-zinc-500"}`} />
          </span>
        </button>
      </div>
    </>
  );
}
