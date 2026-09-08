"use client";

// ============================================================
// Faza 7 — AI HUB (Home): toate funcțiile AI cerute, în unul din
// locuri reale:
//  1. 🤖 AI Analiză conținut — analiză live, auto-refresh 60s,
//     salvată mereu în Neon (ai_insights)
//  2. 🧬 Genuri & Categorii AI — taxonomie creată automat din
//     conținut (gen / categorie / an / deceniu / studio / franciză /
//     colecție / trilogie) → conținutul ajunge în meniul potrivit
//  3. 🪄 Paginare infinită AI — 20 postere/pagină, pagini numerotate
//     create automat, funcții PRECEDENTA / URMĂTOAREA
//  4. 🧠 Extragere metadate AI — TMDB ro-RO + clasificare LLM → Neon
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, RefreshCw, Sparkles, Wand2, ChevronLeft, ChevronRight, Database, Loader2 } from "lucide-react";
import type { MediaItem } from "./types";
import { api } from "./api";
import { MediaCard } from "./MediaCard";
import { Button } from "@/components/ui/button";

// ---------- tipuri ----------
type Snapshot = {
  at: string; total: number;
  byType: { type: string; count: number }[];
  byContinent: { continent: string; count: number }[];
  topCountries: { country: string; count: number }[];
  byDecade: { decade: string; count: number }[];
  topGenres: { name: string; count: number }[];
  totals: {
    views: number; avgRating: number; withYear: number; withoutYear: number;
    withDescription: number; withoutDescription: number; withGenres: number;
    withoutGenres: number; genresTotal: number; countries: number; providers: number;
    playEvents: number; searches24h: number; contentAdded24h: number; aiExtracted: number;
  };
  summary: string; summarySource: string;
};
type TaxEntry = { slug: string; name: string; kind: string; count: number; poster: string | null };
type BrowseItem = {
  id: number; title: string; description: string; contentType: string;
  thumbnail: string | null; backdrop: string | null; year: number | null;
  rating: number; views: number; provider: string; sourceType: string;
  sourceUrl: string | null; embedCode: string | null; country: string | null;
  signed?: boolean;
};
type BrowseResp = {
  items: BrowseItem[]; page: number; size: number; total: number;
  totalPages: number; hasNext: boolean; hasPrev: boolean;
  pageGenres: { name: string; slug: string; kind: string }[];
};
type MetaStats = {
  total: number; noYear: number; noDesc: number; noGenres: number;
  aiExtracted: number; tmdbItems: number;
  jobs: { id: number; kind: string; status: string; processed: number; total: number; inserted: number; startedAt: string; finishedAt: string | null }[];
};

const KINDS: { key: string; label: string; icon: string }[] = [
  { key: "genre", label: "Genuri", icon: "🎭" },
  { key: "category", label: "Categorii", icon: "🗂️" },
  { key: "decade", label: "Decenii", icon: "📅" },
  { key: "year", label: "Ani", icon: "🗓️" },
  { key: "studio", label: "Studiouri", icon: "🎬" },
  { key: "franchise", label: "Francize", icon: "🦸" },
  { key: "collection", label: "Colecții", icon: "📚" },
  { key: "trilogy", label: "Trilogii", icon: "3️⃣" },
];

const TYPE_LABEL: Record<string, string> = {
  movie: "Film", series: "Serial", anime: "Anime", cartoon: "Desen",
  live_tv: "TV Live", radio: "Radio", music: "Muzică", podcast: "Podcast",
  documentary: "Documentar", telenovela: "Telenovelă", showbiz: "Show-biz",
  sport: "Sport", video: "Video", gaming: "Gaming",
};

export function AIHub({
  onPlay, onOpen, isSaved, onToggleList, authed,
}: {
  onPlay: (i: MediaItem) => void;
  onOpen: (i: MediaItem) => void;
  isSaved: (i: MediaItem, k: "watchlist" | "favorites") => boolean;
  onToggleList: (i: MediaItem, k: "watchlist" | "favorites") => void;
  authed: boolean;
}) {
  // 1. analiză live
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [lastAuto, setLastAuto] = useState<string>("");
  // 2. taxonomie
  const [taxonomy, setTaxonomy] = useState<Record<string, TaxEntry[]>>({});
  const [kind, setKind] = useState("genre");
  const [activeSlug, setActiveSlug] = useState<string>("");
  // 3. paginare
  const [browse, setBrowse] = useState<BrowseResp | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [contentType, setContentType] = useState("");
  const [sort, setSort] = useState("popularity");
  const gridRef = useRef<HTMLDivElement>(null);
  // 4. metadate
  const [meta, setMeta] = useState<MetaStats | null>(null);
  const [runningMeta, setRunningMeta] = useState(false);
  const [runningGenres, setRunningGenres] = useState(false);

  const toMedia = (b: BrowseItem): MediaItem => ({
    id: String(b.id), mediaType: "neon", title: b.title, poster: b.thumbnail,
    backdrop: b.backdrop, overview: b.description, year: b.year ? String(b.year) : "",
    rating: b.rating, source: "neon", sourceUrl: b.sourceUrl, embedCode: b.embedCode,
    provider: b.provider, neonId: b.id, signed: Boolean(b.signed),
  });

  // ---- încărcări ----
  const loadSnapshot = useCallback(() => {
    api.aiAnalyzer<{ snapshot: Snapshot | null }>()
      .then((r) => r.snapshot && setSnap(r.snapshot))
      .catch(() => {});
  }, []);

  const loadTaxonomy = useCallback(() => {
    api.aiGenres<{ taxonomy: Record<string, TaxEntry[]> }>()
      .then((r) => setTaxonomy(r.taxonomy || {}))
      .catch(() => {});
  }, []);

  const loadMeta = useCallback(() => {
    api.aiMetadata<MetaStats>().then(setMeta).catch(() => {});
  }, []);

  const loadBrowse = useCallback((p: number, tax: string, slug: string, type: string, srt: string) => {
    setPageLoading(true);
    const q = new URLSearchParams({
      page: String(p), size: "20", sort: srt,
      ...(tax && slug ? { tax, slug } : {}),
      ...(type ? { type } : {}),
    });
    api.browse<BrowseResp>(q.toString())
      .then((r) => { setBrowse(r); setPageLoading(false); })
      .catch(() => setPageLoading(false));
  }, []);

  // inițial + auto-refresh analiză la 60s (AI-ul actualizează mereu analiza)
  useEffect(() => {
    loadSnapshot(); loadTaxonomy(); loadMeta();
    loadBrowse(1, "", "", "", "popularity");
    const t = setInterval(loadSnapshot, 60_000);
    return () => clearInterval(t);
  }, [loadSnapshot, loadTaxonomy, loadMeta, loadBrowse]);

  useEffect(() => { setLastAuto(new Date().toLocaleTimeString("ro-RO")); }, [snap]);

  // filtre schimbate → pagina 1
  useEffect(() => {
    loadBrowse(page, kind, activeSlug, contentType, sort);
  }, [page, kind, activeSlug, contentType, sort, loadBrowse]);

  const runAnalyzer = async () => {
    setAnalyzing(true);
    try { const r = await api.aiAnalyzerRun<{ snapshot: Snapshot }>(); setSnap(r.snapshot); }
    catch { /* toast impuisibil aici — panoul arată eroarea prin lipsa refresh */ }
    setAnalyzing(false);
  };

  const runGenres = async () => {
    setRunningGenres(true);
    try { await api.aiGenresRun(); loadTaxonomy(); loadBrowse(page, kind, activeSlug, contentType, sort); }
    finally { setRunningGenres(false); }
  };

  const runMeta = async () => {
    setRunningMeta(true);
    try { await api.aiMetadataRun(300, 4); loadMeta(); loadBrowse(page, kind, activeSlug, contentType, sort); }
    finally { setRunningMeta(false); }
  };

  const gotoPage = (p: number) => {
    setPage(p);
    gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // numere de pagină cu fereastră: 1 … p-1 p p+1 … N
  const pageNumbers = (cur: number, total: number): (number | "…")[] => {
    if (total <= 9) return Array.from({ length: total }, (_, i) => i + 1);
    const out: (number | "…")[] = [1];
    const s = Math.max(2, cur - 2), e = Math.min(total - 1, cur + 2);
    if (s > 2) out.push("…");
    for (let i = s; i <= e; i++) out.push(i);
    if (e < total - 1) out.push("…");
    out.push(total);
    return out;
  };

  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

  return (
    <section id="ai-hub" className="space-y-5 scroll-mt-20">
      {/* ============ 1. AI ANALIZĂ CONȚINUT (live) ============ */}
      <div className="mx-4 rounded-2xl bg-gradient-to-br from-zinc-900 to-zinc-900/60 p-4 ring-1 ring-red-600/25 sm:mx-6 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-bold text-zinc-100">
            <Bot className="h-5 w-5 text-red-500" />
            AI Analiză conținut — platforma, mereu la zi
            <span className="flex items-center gap-1 rounded-full bg-red-600/15 px-2 py-0.5 text-[10px] font-semibold text-red-400 ring-1 ring-red-600/40">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" /> LIVE
            </span>
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500">
              actualizare auto 60s • {lastAuto}
            </span>
            <Button size="sm" variant="outline" disabled={analyzing} onClick={runAnalyzer}
              className="h-7 gap-1.5 border-red-600/40 px-2.5 text-[11px] text-red-400 hover:bg-red-600/10">
              {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Re-analiză AI
            </Button>
          </div>
        </div>

        {snap ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {[
                { l: "Conținuturi", v: snap.total.toLocaleString("ro-RO") },
                { l: "Taxonomii AI", v: snap.totals.genresTotal.toLocaleString("ro-RO") },
                { l: "Țări", v: snap.totals.countries },
                { l: "Surse", v: snap.totals.providers },
                { l: "Redări", v: snap.totals.playEvents.toLocaleString("ro-RO") },
                { l: "Căutări 24h", v: snap.totals.searches24h.toLocaleString("ro-RO") },
              ].map((s) => (
                <div key={s.l} className="rounded-xl bg-black/40 p-2.5 ring-1 ring-white/5">
                  <p className="text-lg font-black text-zinc-100">{s.v}</p>
                  <p className="text-[10px] uppercase tracking-wide text-zinc-500">{s.l}</p>
                </div>
              ))}
            </div>

            {/* bare progres metadate */}
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {[
                { l: "Cu an", v: snap.totals.withYear, tot: snap.total },
                { l: "Cu descriere", v: snap.totals.withDescription, tot: snap.total },
                { l: "Cu genuri AI", v: snap.totals.withGenres, tot: snap.total },
              ].map((b) => (
                <div key={b.l}>
                  <div className="flex justify-between text-[10px] text-zinc-500">
                    <span>{b.l}</span><span>{pct(b.v, b.tot)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div className="h-full rounded-full bg-gradient-to-r from-red-600 to-amber-500 transition-all" style={{ width: `${pct(b.v, b.tot)}%` }} />
                  </div>
                </div>
              ))}
            </div>

            {snap.summary && (
              <p className="mt-3 rounded-xl bg-red-950/30 p-3 text-[12px] leading-relaxed text-zinc-300 ring-1 ring-red-900/40">
                <Sparkles className="mr-1.5 inline h-3.5 w-3.5 text-amber-400" />
                {snap.summary}
                {snap.summarySource === "llm" && <span className="ml-1.5 text-[9px] uppercase text-zinc-600">— generat AI</span>}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-1.5">
              {snap.byType.slice(0, 8).map((t) => (
                <button key={t.type} onClick={() => { setContentType(t.type); setActiveSlug(""); setPage(1); }}
                  className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition ${
                    contentType === t.type ? "bg-red-600 text-white ring-red-600" : "bg-black/40 text-zinc-400 ring-white/10 hover:ring-red-600/50"
                  }`}>
                  {TYPE_LABEL[t.type] || t.type} · {t.count.toLocaleString("ro-RO")}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">AI-ul analizează biblioteca…</p>
        )}
      </div>

      {/* ============ 2. GENURI & CATEGORII AI ============ */}
      <div className="mx-4 rounded-2xl bg-zinc-900/80 p-4 ring-1 ring-amber-600/20 sm:mx-6 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-bold text-zinc-100">
            <Wand2 className="h-5 w-5 text-amber-500" />
            Genuri & Categorii create automat de AI
          </h3>
          <Button size="sm" variant="outline" disabled={runningGenres} onClick={runGenres}
            className="h-7 gap-1.5 border-amber-600/40 px-2.5 text-[11px] text-amber-400 hover:bg-amber-600/10">
            {runningGenres ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            Regenerare taxonomie
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <button key={k.key} onClick={() => { setKind(k.key); setActiveSlug(""); setPage(1); }}
              className={`cursor-pointer rounded-full px-3 py-1.5 text-[12px] font-semibold ring-1 transition ${
                kind === k.key ? "bg-amber-500 text-black ring-amber-500" : "bg-black/40 text-zinc-400 ring-white/10 hover:ring-amber-500/60"
              }`}>
              {k.icon} {k.label}
              <span className="ml-1 text-[10px] opacity-70">{(taxonomy[k.key] || []).length}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {(taxonomy[kind] || []).length === 0 && (
            <p className="text-[12px] text-zinc-500">
              AI-ul încă generează {KINDS.find((k) => k.key === kind)?.label.toLowerCase()}… apasă „Regenerare taxonomie”.
            </p>
          )}
          {(taxonomy[kind] || []).map((g) => (
            <button key={g.slug} onClick={() => { setActiveSlug(activeSlug === g.slug ? "" : g.slug); setPage(1); }}
              className={`flex cursor-pointer items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12px] ring-1 transition ${
                activeSlug === g.slug ? "bg-red-600 text-white ring-red-600" : "bg-black/40 text-zinc-300 ring-white/10 hover:ring-red-600/50"
              }`}>
              {g.poster ? <img src={g.poster} alt="" className="h-6 w-6 rounded-full object-cover" loading="lazy" /> : <span className="ml-1">🎞️</span>}
              <span className="font-medium">{g.name}</span>
              <span className={`text-[10px] ${activeSlug === g.slug ? "text-zinc-200" : "text-zinc-500"}`}>{g.count.toLocaleString("ro-RO")}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ============ 3. PAGINARE INFINITĂ AI (20 postere/pagină) ============ */}
      <div ref={gridRef} className="mx-4 scroll-mt-20 rounded-2xl bg-zinc-900/80 p-4 ring-1 ring-white/10 sm:mx-6 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-bold text-zinc-100">
            <Sparkles className="h-5 w-5 text-red-500" />
            Explorare AI — paginare infinită
            <span className="rounded-full bg-red-600/15 px-2 py-0.5 text-[10px] font-semibold text-red-400 ring-1 ring-red-600/40">
              20 postere / pagină
            </span>
          </h3>
          <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}
            className="cursor-pointer rounded-lg bg-black/50 px-2.5 py-1.5 text-[12px] text-zinc-300 ring-1 ring-white/10">
            <option value="popularity">Sortare: Popularitate</option>
            <option value="rating">Sortare: Rating</option>
            <option value="newest">Sortare: Cele mai noi</option>
            <option value="views">Sortare: Cele mai vizionate</option>
            <option value="title">Sortare: Titlu A-Z</option>
            <option value="newest_added">Sortare: Adăugate recent</option>
          </select>
        </div>

        {browse && (
          <p className="mt-1.5 text-[11px] text-zinc-500">
            {browse.total.toLocaleString("ro-RO")} conținuturi găsite de AI
            {activeSlug && ` în „${KINDS.find((k) => k.key === kind)?.label}”`}
            {` • pagina ${browse.page} din ${browse.totalPages} (pagini create automat)`}
          </p>
        )}

        {pageLoading ? (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-[2/3] animate-pulse rounded-xl bg-zinc-800/70" />
            ))}
          </div>
        ) : browse && browse.items.length > 0 ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {browse.items.map((b) => {
                const m = toMedia(b);
                return (
                  <div key={b.id} data-ai-click>
                    <MediaCard item={m} onOpen={onOpen} onPlay={onPlay} width="w-full"
                      saved={isSaved(m, "watchlist")} fav={isSaved(m, "favorites")} onToggleList={(mm) => onToggleList(mm, "watchlist")} />
                    <p className="mt-1 truncate text-[10px] text-zinc-600">
                      {TYPE_LABEL[b.contentType] || b.contentType}{b.country ? ` • ${b.country.toUpperCase()}` : ""}{b.views > 0 ? ` • ▶ ${b.views}` : ""}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* numerotare pagini + PRECEDENTA / URMĂTOAREA */}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
              <button onClick={() => browse.hasPrev && gotoPage(page - 1)} disabled={!browse.hasPrev}
                aria-label="Pagina precedentă"
                className={`flex h-9 items-center gap-1 rounded-lg px-3 text-[12px] font-semibold ring-1 transition ${
                  browse.hasPrev ? "cursor-pointer bg-black/50 text-zinc-200 ring-white/15 hover:ring-red-600/60" : "bg-black/30 text-zinc-600 ring-white/5"
                }`}>
                <ChevronLeft className="h-4 w-4" /> Precedenta
              </button>
              {pageNumbers(browse.page, browse.totalPages).map((p, i) =>
                p === "…" ? (
                  <span key={`e-${i}`} className="px-1 text-zinc-600">…</span>
                ) : (
                  <button key={p} onClick={() => gotoPage(p)} aria-current={p === browse.page ? "page" : undefined}
                    className={`h-9 min-w-9 cursor-pointer rounded-lg px-2 text-[12px] font-bold ring-1 transition ${
                      p === browse.page ? "bg-red-600 text-white ring-red-600" : "bg-black/50 text-zinc-300 ring-white/10 hover:ring-red-600/60"
                    }`}>
                    {p}
                  </button>
                )
              )}
              <button onClick={() => browse.hasNext && gotoPage(page + 1)} disabled={!browse.hasNext}
                aria-label="Pagina următoare"
                className={`flex h-9 items-center gap-1 rounded-lg px-3 text-[12px] font-semibold ring-1 transition ${
                  browse.hasNext ? "cursor-pointer bg-black/50 text-zinc-200 ring-white/15 hover:ring-red-600/60" : "bg-black/30 text-zinc-600 ring-white/5"
                }`}>
                Următoarea <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">Niciun conținut pentru filtrele AI alese.</p>
        )}
      </div>

      {/* ============ 4. EXTRAGERE METADATE AI ============ */}
      <div className="mx-4 rounded-2xl bg-zinc-900/80 p-4 ring-1 ring-emerald-600/20 sm:mx-6 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-bold text-zinc-100">
            <Database className="h-5 w-5 text-emerald-500" />
            AI Extragere metadate reale → salvate în Neon
          </h3>
          <Button size="sm" variant="outline" disabled={runningMeta} onClick={runMeta}
            className="h-7 gap-1.5 border-emerald-600/40 px-2.5 text-[11px] text-emerald-400 hover:bg-emerald-600/10">
            {runningMeta ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
            Extrage următorul lot
          </Button>
        </div>

        {meta ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                { l: "Total conținut", v: meta.total, c: "text-zinc-100" },
                { l: "Fără an", v: meta.noYear, c: "text-amber-400" },
                { l: "Fără descriere", v: meta.noDesc, c: "text-amber-400" },
                { l: "Fără genuri", v: meta.noGenres, c: "text-amber-400" },
                { l: "Extrase de AI", v: meta.aiExtracted, c: "text-emerald-400" },
              ].map((s) => (
                <div key={s.l} className="rounded-xl bg-black/40 p-2.5 ring-1 ring-white/5">
                  <p className={`text-lg font-black ${s.c}`}>{s.v.toLocaleString("ro-RO")}</p>
                  <p className="text-[10px] uppercase tracking-wide text-zinc-500">{s.l}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              AI-ul completează automat: detalii TMDB în română (an, descriere, genuri, studiouri, colecții, rating, imagini),
              clasificare LLM pentru canale TV/radio, descrieri derivate din câmpuri reale.
              Surse TMDB în bibliotecă: {meta.tmdbItems.toLocaleString("ro-RO")}. Rulează repetat — fiecare lot continuă de unde a rămas.
            </p>
            {meta.jobs.length > 0 && (
              <div className="mt-2 space-y-1">
                {meta.jobs.slice(0, 3).map((j) => (
                  <div key={j.id} className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <span className={`h-1.5 w-1.5 rounded-full ${j.status === "done" ? "bg-emerald-500" : j.status === "running" ? "animate-pulse bg-amber-500" : "bg-red-500"}`} />
                    <span className="font-mono">{j.kind}</span>
                    <span className="text-zinc-600">#{j.id}</span>
                    <span>{j.processed}/{j.total} procesate</span>
                    {j.inserted > 0 && <span className="text-emerald-500">+{j.inserted} legături</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">Se încarcă statisticile metadatelor…</p>
        )}
      </div>

      {authed && (
        <p className="mx-4 text-center text-[10px] text-zinc-600 sm:mx-6">
          Recomandările AI folosesc istoricul tău de vizionare salvat în Neon.
        </p>
      )}
    </section>
  );
}
