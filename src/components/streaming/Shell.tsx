"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession, signOut, signIn } from "next-auth/react";
import {
  Home, Film, Tv, Sparkles, Music2, Baby, Trophy, Gamepad2,
  Globe2, Heart, Newspaper, Laugh, Bookmark, Search, Menu, X, LogIn, LogOut, User,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import type { MediaItem, ViewKey, UserItem } from "./types";
import { api } from "./api";
import { HomeView } from "./HomeView";
import { CatalogView } from "./CatalogView";
import { AnimeView } from "./AnimeView";
import { MusicView } from "./MusicView";
import { KidsView } from "./KidsView";
import { SportsView } from "./SportsView";
import { GamingView } from "./GamingView";
import { NewsView } from "./NewsView";
import { FunView } from "./FunView";
import { MyListView } from "./MyListView";
import { SearchView } from "./SearchView";
import { UniversuriView } from "./UniversuriView";
import { ShowbizView } from "./ShowbizView";
import { DetailModal } from "./DetailModal";
import { PlayerModal } from "./PlayerModal";

const NAV: { key: ViewKey; label: string; icon: typeof Home; group: string }[] = [
  { key: "acasa", label: "Acasă", icon: Home, group: "Principal" },
  { key: "filme", label: "Filme", icon: Film, group: "Principal" },
  { key: "seriale", label: "Seriale", icon: Tv, group: "Principal" },
  { key: "anime", label: "Anime", icon: Sparkles, group: "Principal" },
  { key: "copii", label: "Copii & Desene", icon: Baby, group: "Principal" },
  { key: "muzica", label: "Muzică", icon: Music2, group: "Media" },
  { key: "documentare", label: "Documentare", icon: Globe2, group: "Media" },
  { key: "telenovele", label: "Telenovele", icon: Heart, group: "Media" },
  { key: "sport", label: "Sport", icon: Trophy, group: "Live" },
  { key: "gaming", label: "Gaming", icon: Gamepad2, group: "Live" },
  { key: "stiri", label: "Știri", icon: Newspaper, group: "Live" },
  { key: "fun", label: "Distracție", icon: Laugh, group: "Live" },
  { key: "lista", label: "Lista Mea", icon: Bookmark, group: "Cont" },
];

// Faza 4: meniuri COMPLET FUNCȚIONALE — fiecare item navighează la view + parametru
// (înainte erau „CURÂND” — acum activ: Universuri, Canale Kids, TV & Show-biz, Lumea)
type ExtraItem = { label: string; icon: string; group: string; view: ViewKey; param: string };
const NAV_EXTRA: ExtraItem[] = [
  { label: "Marvel", icon: "🦸", group: "Universuri", view: "universuri", param: "marvel" },
  { label: "DC", icon: "🦇", group: "Universuri", view: "universuri", param: "dc" },
  { label: "Blockbustere", icon: "💥", group: "Universuri", view: "universuri", param: "blockbuster" },
  { label: "Disney", icon: "🏰", group: "Canale Kids", view: "copii", param: "disney" },
  { label: "Jetix", icon: "⚡", group: "Canale Kids", view: "copii", param: "jetix" },
  { label: "Fox Kids", icon: "🦊", group: "Canale Kids", view: "copii", param: "fox-kids" },
  { label: "Cartoon Network", icon: "📺", group: "Canale Kids", view: "copii", param: "cartoon-network" },
  { label: "Boomerang", icon: "🪃", group: "Canale Kids", view: "copii", param: "boomerang" },
  { label: "Minimax", icon: "🎈", group: "Canale Kids", view: "copii", param: "minimax" },
  { label: "Divertisment", icon: "🎭", group: "TV & Show-biz", view: "showbiz", param: "divertisment" },
  { label: "Show-biz", icon: "⭐", group: "TV & Show-biz", view: "showbiz", param: "showbiz" },
  { label: "Reality TV", icon: "🎤", group: "TV & Show-biz", view: "showbiz", param: "reality" },
  { label: "Emisiuni TV", icon: "🎙️", group: "TV & Show-biz", view: "showbiz", param: "emisiuni" },
  { label: "Europa", icon: "🇪🇺", group: "Lumea — 196 țări", view: "stiri", param: "Europa" },
  { label: "America de Nord", icon: "🌎", group: "Lumea — 196 țări", view: "stiri", param: "America de Nord" },
  { label: "America de Sud", icon: "🌏", group: "Lumea — 196 țări", view: "stiri", param: "America de Sud" },
  { label: "Asia", icon: "🏯", group: "Lumea — 196 țări", view: "stiri", param: "Asia" },
  { label: "Africa", icon: "🌍", group: "Lumea — 196 țări", view: "stiri", param: "Africa" },
  { label: "Oceania", icon: "🏝️", group: "Lumea — 196 țări", view: "stiri", param: "Oceania" },
];
const EXTRA_GROUPS = Array.from(new Set(NAV_EXTRA.map((n) => n.group)));

type Profile = { id: string; name: string; avatar: string; color: string; isKid: boolean };

export function Shell() {
  const { data: session, status } = useSession();
  const authed = status === "authenticated";
  const authedStable = useMemo(() => authed, [authed]);

  const [view, setView] = useState<ViewKey>("acasa");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Faza 4: parametri pentru meniurile avansate (tab/brand/continent)
  const [universuriTab, setUniversuriTab] = useState("marvel");
  const [showbizTab, setShowbizTab] = useState("divertisment");
  const [kidsBrand, setKidsBrand] = useState("disney");
  const [newsContinent, setNewsContinent] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  // Faza 3: autocompletare live din Neon (suggest API)
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSug, setShowSug] = useState(false);
  const [sugIdx, setSugIdx] = useState(-1);
  const sugAbort = useRef<AbortController | null>(null);
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [playerItem, setPlayerItem] = useState<MediaItem | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [newProfile, setNewProfile] = useState({ name: "", avatar: "🎬" });
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");

  // încarcă watchlist + favorite
  useEffect(() => {
    if (!authedStable) return;
    let cancelled = false;
    (async () => {
      try {
        const [wl, favs] = await Promise.all([
          api.user<{ items: UserItem[] }>("watchlist"),
          api.user<{ items: UserItem[] }>("favorites"),
        ]);
        if (cancelled) return;
        setSavedIds(new Set(wl.items.map((i) => `${i.mediaType}:${i.mediaId}`)));
        setFavIds(new Set(favs.items.map((i) => `${i.mediaType}:${i.mediaId}`)));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [authedStable, refreshKey]);

  // profiluri
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    api.user<{ items: Profile[] }>("profiles")
      .then((r) => {
        if (cancelled) return;
        setProfiles(r.items);
        setActiveProfile((prev) =>
          prev && r.items.some((p) => p.id === prev.id) ? prev : (r.items[0] ?? null)
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authed]);

  const keyOf = (i: MediaItem) => `${i.mediaType}:${i.id}`;

  const viewSaved = authedStable ? savedIds : new Set<string>();
  const viewFav = authedStable ? favIds : new Set<string>();

  const isSaved = useCallback(
    (i: MediaItem, kind: "watchlist" | "favorites") =>
      (kind === "watchlist" ? viewSaved : viewFav).has(keyOf(i)),
    [viewSaved, viewFav]
  );

  const toggleList = useCallback(async (i: MediaItem, kind: "watchlist" | "favorites") => {
    if (!authed) {
      toast({ title: "Autentificare necesară", description: "Conectează-te cu Google pentru a salva titluri." });
      return;
    }
    const setter = kind === "watchlist" ? setSavedIds : setFavIds;
    const active = keyOf(i);
    try {
      const r = await api.userPost<{ active?: boolean }>({
        action: "toggle", kind,
        media: {
          mediaId: i.id, mediaType: i.mediaType, title: i.title, poster: i.poster,
          backdrop: i.backdrop, year: i.year, rating: i.rating, source: i.source || "tmdb",
        },
      });
      setter((prev) => {
        const next = new Set(prev);
        if (r.active) next.add(active); else next.delete(active);
        return next;
      });
      setRefreshKey((k) => k + 1);
      toast({
        title: r.active ? "Adăugat ✅" : "Eliminat",
        description: `${i.title} — ${kind === "watchlist" ? "watchlist" : "favorite"}`,
      });
    } catch {
      toast({ title: "Eroare la salvare", variant: "destructive" });
    }
  }, [authed]);

  const openDetail = useCallback((i: MediaItem) => {
    setDetailItem(i); setDetailOpen(true);
  }, []);

  const openPlayer = useCallback((i: MediaItem) => {
    setPlayerItem(i); setPlayerOpen(true);
  }, []);

  const navigate = useCallback((v: string) => {
    setView(v as ViewKey);
    setSidebarOpen(false);
    window.scrollTo({ top: 0 });
  }, []);

  // Faza 4: navigare din meniurile avansate — setează parametrul view-ului țintă
  const navigateExtra = useCallback((item: ExtraItem) => {
    if (item.view === "universuri") setUniversuriTab(item.param);
    else if (item.view === "showbiz") setShowbizTab(item.param);
    else if (item.view === "copii") setKidsBrand(item.param);
    else if (item.view === "stiri") setNewsContinent(item.param);
    setView(item.view);
    setSidebarOpen(false);
    window.scrollTo({ top: 0 });
  }, []);

  // autocompletare live: debounce 180ms → /api/search?mode=suggest (Neon)
  // q gol → trending din search_stats (upsert_search_stat)
  useEffect(() => {
    const t = setTimeout(() => {
      sugAbort.current?.abort();
      const ac = new AbortController();
      sugAbort.current = ac;
      fetch(`/api/search?mode=suggest&q=${encodeURIComponent(searchInput.trim())}`, {
        signal: ac.signal,
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : { suggestions: [] }))
        .then((d: { suggestions?: string[] }) => {
          if (ac.signal.aborted) return;
          setSuggestions((d.suggestions || []).slice(0, 7));
          setSugIdx(-1);
        })
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [searchInput]);

  const pickSuggestion = useCallback(
    (s: string) => {
      setSearchInput(s);
      setSearchQuery(s);
      setShowSug(false);
      navigate("search");
    },
    [navigate]
  );

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      setSearchQuery(searchInput.trim());
      setShowSug(false);
      navigate("search");
    }
  };

  const addProfile = async () => {
    if (!newProfile.name.trim()) return;
    try {
      const p = await api.userPost<Profile>({
        action: "add", kind: "profiles",
        profile: { name: newProfile.name.trim(), avatar: newProfile.avatar },
      });
      setProfiles((prev) => [...prev, p]);
      setActiveProfile(p);
      setProfileDialogOpen(false);
      setNewProfile({ name: "", avatar: "🎬" });
      toast({ title: "Profil creat ✅", description: p.name });
    } catch {
      toast({ title: "Eroare", description: "Nu am putut crea profilul.", variant: "destructive" });
    }
  };

  const groups = Array.from(new Set(NAV.map((n) => n.group)));

  const sidebarContent = (
    <>
      <div className="mb-6 flex items-center gap-2 px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-600 text-lg font-black shadow-lg shadow-red-600/30">S</div>
        <div>
          <p className="text-base font-black leading-none tracking-tight">Stream<span className="text-red-500">Verse</span></p>
          <p className="mt-0.5 text-[10px] text-zinc-500">196 țări • 6 continente</p>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-2 pb-4">
        {groups.map((g) => (
          <div key={g}>
            <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-zinc-600">{g}</p>
            {NAV.filter((n) => n.group === g).map((n) => (
              <button
                key={n.key}
                onClick={() => navigate(n.key)}
                className={`mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  view === n.key
                    ? "bg-red-600/15 text-red-400 ring-1 ring-red-600/30"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
              >
                <n.icon className="h-4 w-4 shrink-0" />
                {n.label}
              </button>
            ))}
          </div>
        ))}

        {EXTRA_GROUPS.map((g) => (
          <div key={g}>
            <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-zinc-700">{g}</p>
            {NAV_EXTRA.filter((n) => n.group === g).map((n) => {
              const active = view === n.view &&
                (n.view === "universuri" ? universuriTab === n.param
                  : n.view === "showbiz" ? showbizTab === n.param
                  : n.view === "copii" ? kidsBrand === n.param
                  : newsContinent === n.param);
              return (
                <button
                  key={n.label}
                  onClick={() => navigateExtra(n)}
                  title={`Deschide ${n.label}`}
                  className={`mb-0.5 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    active
                      ? "bg-red-600/15 text-red-400 ring-1 ring-red-600/30"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                  }`}
                >
                  <span className="w-4 shrink-0 text-center text-base leading-none">{n.icon}</span>
                  <span className="flex-1 truncate">{n.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-zinc-900 p-4">
        {authed ? (
          <div className="text-xs text-zinc-500">
            <p className="truncate font-semibold text-zinc-300">{session?.user?.name}</p>
            <p className="truncate">{session?.user?.email}</p>
          </div>
        ) : (
          <p className="text-xs text-zinc-600">Conectează-te pentru a salva favoritele și progresul.</p>
        )}
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0a0f]">
      {/* SIDEBAR desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-zinc-900 bg-[#0c0c12] lg:flex">
        {sidebarContent}
      </aside>

      {/* SIDEBAR mobile */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-zinc-900 bg-[#0c0c12]">
            <button
              aria-label="Închide meniul"
              onClick={() => setSidebarOpen(false)}
              className="absolute right-3 top-3 rounded-full p-1.5 text-zinc-400 hover:bg-zinc-800"
            >
              <X className="h-4 w-4" />
            </button>
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* TOPBAR */}
      <header className="sticky top-0 z-20 border-b border-zinc-900 bg-[#0a0a0f]/90 backdrop-blur-lg lg:pl-60">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
          <button
            aria-label="Deschide meniul"
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>

          <form onSubmit={submitSearch} className="relative max-w-md flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
            <Input
              value={searchInput}
              onChange={(e) => { setSearchInput(e.target.value); setShowSug(true); }}
              onFocus={() => setShowSug(true)}
              onBlur={() => setTimeout(() => setShowSug(false), 120)}
              onKeyDown={(e) => {
                if (!showSug || suggestions.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSugIdx((i) => (i + 1) % suggestions.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSugIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
                } else if (e.key === "Enter" && sugIdx >= 0) {
                  e.preventDefault();
                  pickSuggestion(suggestions[sugIdx]);
                } else if (e.key === "Escape") {
                  setShowSug(false);
                }
              }}
              placeholder="Caută filme, seriale, anime, muzică..."
              className="h-9 border-zinc-800 bg-zinc-900/80 pl-8 text-sm text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-red-600/50"
              aria-autocomplete="list"
              aria-expanded={showSug && suggestions.length > 0}
              role="combobox"
            />
            {showSug && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur">
                <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-zinc-600">
                  {searchInput.trim() ? "🧠 Sugestii din biblioteca Neon" : "🔥 Căutări populare acum"}
                </p>
                {suggestions.map((s, i) => (
                  <button
                    type="button"
                    key={`${s}:${i}`}
                    onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                    onMouseEnter={() => setSugIdx(i)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                      i === sugIdx ? "bg-red-600/20 text-red-300" : "text-zinc-300"
                    }`}
                  >
                    <Search className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                    <span className="truncate">{s}</span>
                  </button>
                ))}
              </div>
            )}
          </form>

          <div className="ml-auto flex items-center gap-2">
            {/* profiluri */}
            {authed && profiles.length > 0 && (
              <div className="hidden items-center gap-1.5 sm:flex">
                {profiles.slice(0, 4).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setActiveProfile(p)}
                    title={p.name}
                    className={`flex h-8 w-8 items-center justify-center rounded-lg text-base ring-2 transition ${
                      activeProfile?.id === p.id ? "ring-red-600" : "ring-transparent hover:ring-zinc-600"
                    }`}
                    style={{ backgroundColor: `${p.color}33` }}
                  >
                    {p.avatar}
                  </button>
                ))}
                <button
                  onClick={() => setProfileDialogOpen(true)}
                  aria-label="Adaugă profil"
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-zinc-500 ring-1 ring-zinc-800 hover:text-zinc-200"
                >
                  +
                </button>
              </div>
            )}

            {authed ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="Meniu cont"
                    className="flex h-9 items-center gap-2 rounded-full bg-zinc-900 pl-1.5 pr-3 ring-1 ring-zinc-800 hover:ring-zinc-600 transition"
                  >
                    {session?.user?.image ? (
                       
                      <img src={session.user.image} alt="Avatar" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-xs font-black text-white">
                        {(session?.user?.name || "U").charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="hidden max-w-[120px] truncate text-xs font-semibold text-zinc-200 sm:block">
                      {session?.user?.name}
                    </span>
                    <User className="h-3.5 w-3.5 text-zinc-500" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-950 text-zinc-200">
                  <DropdownMenuLabel className="text-xs">
                    {session?.user?.email}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator className="bg-zinc-800" />
                  <DropdownMenuItem onClick={() => navigate("lista")} className="text-xs cursor-pointer">
                    <Bookmark className="h-3.5 w-3.5 mr-2" /> Lista mea
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setProfileDialogOpen(true)} className="text-xs cursor-pointer">
                    <User className="h-3.5 w-3.5 mr-2" /> Gestionează profiluri
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="bg-zinc-800" />
                  <DropdownMenuItem
                    onClick={() => signOut()}
                    className="text-xs cursor-pointer text-red-400 focus:text-red-300"
                  >
                    <LogOut className="h-3.5 w-3.5 mr-2" /> Deconectare
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="Conectare"
                    className="flex h-9 items-center gap-2 rounded-full bg-red-600 px-4 text-xs font-bold text-white transition hover:bg-red-500"
                  >
                    <LogIn className="h-3.5 w-3.5" /> Conectare
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-950 text-zinc-200">
                  <DropdownMenuItem
                    onClick={() => signIn("google")}
                    className="text-xs cursor-pointer"
                  >
                    <span className="mr-2 text-sm">🌐</span> Continuă cu Google
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setLoginDialogOpen(true)}
                    className="text-xs cursor-pointer"
                  >
                    <span className="mr-2 text-sm">✉️</span> Conectare demo (email)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      {/* CONȚINUT */}
      <main className="flex-1 pb-10 lg:pl-60">
        {view === "acasa" && (
          <HomeView
            onPlay={openPlayer} onOpen={openDetail}
            onNavigate={navigate}
            isSaved={isSaved} onToggleList={toggleList}
            authed={authedStable}
          />
        )}
        {view === "filme" && (
          <CatalogView kind="filme" onPlay={openPlayer} onOpen={openDetail} isSaved={isSaved} onToggleList={toggleList} />
        )}
        {view === "seriale" && (
          <CatalogView kind="seriale" onPlay={openPlayer} onOpen={openDetail} isSaved={isSaved} onToggleList={toggleList} />
        )}
        {view === "documentare" && (
          <CatalogView kind="documentare" onPlay={openPlayer} onOpen={openDetail} isSaved={isSaved} onToggleList={toggleList} />
        )}
        {view === "telenovele" && (
          <CatalogView kind="telenovele" onPlay={openPlayer} onOpen={openDetail} isSaved={isSaved} onToggleList={toggleList} />
        )}
        {view === "anime" && (
          <AnimeView onPlay={openPlayer} onOpen={openDetail} isSaved={isSaved} onToggleList={toggleList} />
        )}
        {view === "muzica" && <MusicView />}
        {view === "copii" && (
          <KidsView key={`kids-${kidsBrand}`} initialBrand={kidsBrand} onPlay={openPlayer} onOpen={openDetail} isSaved={isSaved} onToggleList={toggleList} />
        )}
        {view === "sport" && <SportsView />}
        {view === "gaming" && <GamingView />}
        {view === "stiri" && <NewsView key={`stiri-${newsContinent}`} initialContinent={newsContinent} />}
        {view === "fun" && <FunView />}
        {view === "universuri" && (
          <UniversuriView key={`uni-${universuriTab}`} initialTab={universuriTab} onPlay={openPlayer} onOpen={openDetail} isSaved={isSaved} onToggleList={toggleList} />
        )}
        {view === "showbiz" && (
          <ShowbizView key={`sb-${showbizTab}`} initialTab={showbizTab} onPlay={openPlayer} onOpen={openDetail} isSaved={isSaved} onToggleList={toggleList} />
        )}
        {view === "lista" && (
          <MyListView
            authed={authedStable}
            onOpen={openDetail} onPlay={openPlayer}
            isSaved={isSaved} onToggleList={toggleList}
            refreshKey={refreshKey}
          />
        )}
        {view === "search" && (
          <SearchView
            query={searchQuery}
            onPlay={openPlayer} onOpen={openDetail}
            isSaved={isSaved} onToggleList={toggleList}
          />
        )}
      </main>

      {/* FOOTER sticky */}
      <footer className="mt-auto border-t border-zinc-900 bg-[#0c0c12] py-5 lg:pl-60">
        <div className="px-4 text-center sm:px-6">
          <p className="text-xs text-zinc-500">
            <span className="font-black text-zinc-300">StreamVerse</span> — platformă demonstrativă de streaming universal.
            Metadata & trailere: <span className="text-zinc-400">TMDB, MyAnimeList, TVMaze, iTunes, YouTube, OpenSubtitles</span>.
          </p>
          <p className="mt-1 text-[11px] text-zinc-600">
            Filme • Seriale • Anime • Muzică • Copii • Sport • Gaming • Documentare • Telenovele • Știri — din 6 continente și 196 de țări 🌍
          </p>
        </div>
      </footer>

      {/* MODALS */}
      <DetailModal
        item={detailItem} open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onPlay={(i) => { setDetailOpen(false); openPlayer(i); }}
        onOpenItem={openDetail}
        isSaved={isSaved} onToggleList={toggleList}
        authed={authedStable}
      />
      <PlayerModal
        item={playerItem} open={playerOpen}
        onClose={() => setPlayerOpen(false)}
        authed={authedStable}
      />

      {/* DIALOG login demo */}
      <Dialog open={loginDialogOpen} onOpenChange={setLoginDialogOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-lg font-black">Conectare demo</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-zinc-500">
            Introdu un email oarecare pentru un cont demonstrativ. Datele se salvează în Neon Cloud.
          </p>
          <Input
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            type="email"
            placeholder="nume@exemplu.ro"
            className="border-zinc-800 bg-zinc-900 text-sm"
          />
          <button
            onClick={async () => {
              if (!loginEmail.includes("@")) {
                toast({ title: "Email invalid", variant: "destructive" });
                return;
              }
              const res = await signIn("credentials", {
                email: loginEmail,
                redirect: false,
              });
              if (res?.error) {
                toast({ title: "Autentificare eșuată", variant: "destructive" });
              } else {
                setLoginDialogOpen(false);
                window.location.reload();
              }
            }}
            className="w-full rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-500 transition"
          >
            Intră în cont
          </button>
        </DialogContent>
      </Dialog>

      {/* DIALOG profil nou */}
      <Dialog open={profileDialogOpen} onOpenChange={setProfileDialogOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-lg font-black">Profil nou</DialogTitle>
          </DialogHeader>
          <Input
            value={newProfile.name}
            onChange={(e) => setNewProfile((p) => ({ ...p, name: e.target.value }))}
            placeholder="Nume profil (ex. Copii, Mamă...)"
            className="border-zinc-800 bg-zinc-900 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            {["🎬", "👶", "🦸", "🐱", "👽", "🤖", "🌸", "🦁"].map((a) => (
              <button
                key={a}
                onClick={() => setNewProfile((p) => ({ ...p, avatar: a }))}
                className={`flex h-10 w-10 items-center justify-center rounded-lg text-xl transition ${
                  newProfile.avatar === a ? "bg-red-600/30 ring-2 ring-red-600" : "bg-zinc-900 ring-1 ring-zinc-800 hover:bg-zinc-800"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
          <button
            onClick={addProfile}
            className="w-full rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-500 transition"
          >
            Creează profilul
          </button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
