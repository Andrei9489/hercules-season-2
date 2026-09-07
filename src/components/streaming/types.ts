// Tipuri partajate pentru platformă
export type MediaItem = {
  id: string;
  mediaType: "movie" | "tv" | "anime" | "music" | "video" | "tv-maze" | string;
  title: string;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  year: string;
  rating: number;
  source: string;
  trailerKey?: string | null;
  episodes?: number | null;
  genres?: string[];
  extra?: Record<string, unknown>;
  // câmpuri bibliotecă Neon (redare universală)
  sourceUrl?: string | null;
  embedCode?: string | null;
  provider?: string | null;
  neonId?: number | null;
};

// Item din biblioteca Neon (redare din URL/embed extern)
export type LibraryItem = {
  id: number;
  externalId: string;
  title: string;
  originalTitle?: string | null;
  description: string;
  contentType: string;
  brand: string | null;
  category: string | null;
  continent: string | null;
  country: string | null;
  provider: string;
  sourceType: string;
  sourceUrl: string | null;
  embedCode: string | null;
  thumbnail: string | null;
  backdrop: string | null;
  year: number | null;
  rating: number;
  popularity: number;
  views: number;
};

export type CapacityStatus = {
  ok: boolean;
  db: {
    provider: string; region: string; size: string;
    partitions: number; indexes: number; stateless: boolean; zeroLocal: boolean;
  };
  library: {
    items: number; types: number; providers: number; liveTvChannels?: number;
    countries?: number; streamFormats?: Record<string, number>;
  };
  search: {
    logsTotal: number; logs24h: number; avgMs: number | null;
    top: { original: string; hits: number }[];
    cacheL2?: { enabled: boolean; ttlSec: number; shared: boolean; note: string };
  };
  player?: { compatPct: number; engines: string[] };
  benchmark?: {
    at: string; peakLocalRps: number; note: string;
    concurrent150: { rps: number; errors?: number; cacheHitPct: number; p95Ms?: number };
    concurrent50: { rps: number; p95Ms: number; cacheHitPct: number };
    concurrent300?: { rps: number; errors: number; cacheHitPct: number };
  };
  capacity: {
    engine: { pct: number; validatedRows: number; target: number; phase: number; nextSteps: string[] };
    concurrentSearches: { pct: number; now: number; target: number; mechanisms: string[] };
    concurrentUsers: { pct: number; now: number; target: number; mechanisms: string[] };
  };
};

export type UserItem = {
  id: string;
  mediaId: string;
  mediaType: string;
  title: string;
  poster: string | null;
  backdrop?: string | null;
  year?: string | null;
  rating?: number | null;
  source?: string;
  progress?: number;
  duration?: number;
  trailerKey?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SportEvent = {
  id: string;
  competition: string;
  home: string;
  away: string;
  score: string | null;
  date: string;
  status: string;
  sport: string;
  source: string;
};

export type Standing = {
  pos: number;
  team: string;
  crest: string | null;
  j: number;
  v: number;
  e: number;
  i: number;
  gm: number;
  gp: number;
  pct: number;
};

export type NewsItem = {
  id: string;
  title: string;
  description: string;
  link: string;
  image: string | null;
  source: string;
  date: string;
};

export type MusicData = {
  songs: {
    id: string;
    kind: string;
    title: string;
    artist: string;
    album: string | null;
    artwork: string | null;
    preview: string | null;
    youtubeKey: string | null;
    year: string;
    genre: string;
    source: string;
  }[];
  videos: {
    id: string;
    kind: string;
    title: string;
    artist: string;
    album: string | null;
    artwork: string | null;
    preview: string | null;
    youtubeKey: string | null;
    year: string;
    genre: string;
    source: string;
  }[];
};

export type GameItem = {
  id: string;
  name: string;
  detail: string;
  image: string | null;
  category: string;
  source: string;
  extra?: Record<string, unknown>;
};

export type KidItem = {
  id: string;
  name: string;
  detail: string;
  image: string | null;
  category: string;
  source: string;
};

export type TriviaQ = {
  id: number;
  question: string;
  correct: string;
  answers: string[];
  category: string;
  difficulty: string;
};

export type DetailData = MediaItem & {
  trailerKey: string | null;
  raw?: Record<string, unknown>;
  episodeCount?: number;
  seasons?: number;
  network?: string;
  status?: string;
};

// Categorii navigație
export type ViewKey =
  | "acasa" | "filme" | "seriale" | "anime" | "muzica" | "copii"
  | "sport" | "gaming" | "documentare" | "telenovele" | "stiri"
  | "fun" | "lista" | "search" | "universuri" | "showbiz";
