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
  /** Stream cu semnare server-side (token/HMAC/JWT) — secretul nu părăsește serverul. */
  signed?: boolean;
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
  /** Stream cu semnare server-side (token/HMAC/JWT). */
  signed?: boolean;
};

export type CapacityStatus = {
  ok: boolean;
  db: {
    provider: string; region: string; size: string;
    partitions: number; indexes: number; stateless: boolean; zeroLocal: boolean;
    readReplica?: boolean; readPoolMax?: number; note?: string;
  };
  library: {
    items: number; types: number; providers: number; liveTvChannels?: number;
    radioStations?: number;
    countries?: number; streamFormats?: Record<string, number>;
  };
  search: {
    logsTotal: number; logs24h: number; avgMs: number | null;
    top: { original: string; hits: number }[];
    cacheL2?: { enabled: boolean; ttlSec: number; shared: boolean; note: string };
    suggest?: {
      coveringIndex: boolean; l2TtlSec: number; coalescing: boolean; originMs: number;
      rollup?: {
        buckets: number; prefixLens: string; topPerBucket: number;
        rankedBy: string; staleAfterMin: number; note: string;
      };
    };
  };
  player?: {
    compatPct: number; engines: string[];
    signing?: { endpoint: string; schemes: string[]; secretExposure: string };
  };
  resilience?: {
    phase: number;
    circuitBreaker: { state: string; failures: number; totalTrips: number; totalFailFast: number; openedAt: number | null };
    admissionControl: { inFlight: number; waiting: number; maxConcurrent: number; maxObserved: number; timedOut: number };
    statementTimeout: { readMs: number; writeMs: number };
    degradedMode: string;
    healthEndpoint: string;
  };
  faza11?: {
    collections: { enabled: boolean; endpoint: string; tables: string[]; storage: string; limits: { maxCollections: number; maxItems: number }; ui: string[] };
    continueWatching: { enabled: boolean; resumeFrom: string; engines: string[]; progressSave: string };
    maintenance: { endpoint: string; operations: string[]; cronRecomandat: string };
  };
  faza12?: {
    partitions: { content: number; playback: number; expansion: string };
    empirical: { rowsLoaded: number; searchP50Ms: number; suggestP50Ms: number; planningMs: number; perPartitionCeiling: number; note: string };
    swr: { search: boolean; suggest: boolean; trending: boolean; edgeOffloadPct: number; note: string };
    replicaProbe: string;
  };
  faza13?: {
    pwa: {
      enabled: boolean;
      manifest: string;
      serviceWorker: string;
      apiSwr: string[];
      neverCached: string[];
      offloadNote: string;
      escap: string;
    };
    cronIntern: {
      enabled: boolean;
      intervalH: number;
      bootDelayS: number;
      lockMechanism: string;
      journal: string;
      observability: string;
      configurare: string;
    };
  };
  faza15?: {
    sharding: {
      enabled: boolean;
      activeComputes: number;
      totalRegistered: number;
      shards: { id: number; name: string; kind: string; region: string; weight: number; state: string; rows: number | null; maxRows: number; lastPingMs: number | null; ok: boolean | null }[];
      engineCeilingDynamic: number;
      computeFor30B: { atX64: number; atX256: number };
      routing: string;
      search: string;
      validation: string;
      admin: string;
    };
    production: { build: string; scaleOut: string };
  };
  faza14?: {
    neonSync: {
      enabled: boolean;
      endpoint: string;
      ui: string;
      outbox: string;
      idempotence: string;
      journal: string;
      batchLimit: number;
    };
  };
  faza16?: {
    replica: { dedicatedPool: boolean; routing: string; searchIntegration: string; probe: string };
    regions: {
      total: number; active: number;
      list: { code: string; group: string; role: string; state: string; dsnSet: boolean; envVar: string | null; lastPingMs: number | null }[];
      note: string;
      runbook: string;
    };
    duplicates: { guardOnAdd: string; scan: string; autoDedupe: string; alerting: string };
    manage: { postersBulkDelete: string; contentBulkDelete: string; audit: string; cache: string };
    ingest: {
      totalProcessed: number; peakSimultaneous: number; waves: number; shardsUsed: number;
      throughputRps: number; distributionRatio: number; searchP50Ms: number; searchP95Ms: number;
      storageCeilingNote: string; scalingNote: string;
    };
  };
  userDriven?: {
    import: {
      sources: string;
      platforms: string[];
      m3u: { enabled: boolean; maxPerImport: number; idempotent: boolean; features: string[] };
      metadateReale: string;
    };
  };
  benchmark?: {
    at: string; peakLocalRps: number; note: string;
    comparableAnchorRps?: number;
    concurrent150: { rps: number; errors?: number; cacheHitPct: number; p95Ms?: number };
    concurrent50: { rps: number; p95Ms: number; cacheHitPct: number };
    concurrent300?: { rps: number; errors: number; cacheHitPct: number };
    suggest150?: { rps: number; p50Ms: number };
    suggest300?: { rps: number; p50Ms: number; errors: number };
    channels?: { rps: number; p50Ms: number };
    radio?: { rps: number; p50Ms: number };
    cluster?: { instances: number; lb: string; rps: number; originRps: number; originScaleVsSingle: number; sessionsPerInstance: number; anchorMillions: number; errorsNote: string };
  };
  capacity: {
    engine: { pct: number; validatedRows: number; target: number; phase: number; nextSteps: string[] };
    concurrentSearches: { pct: number; now: number; target: number; mechanisms: string[] };
    concurrentUsers: { pct: number; now: number; target: number; mechanisms: string[]; anchorFormula?: string };
  };
};

// FAZA 11 — istoric cu progres real (pentru „Continuă vizionarea”)
export type HistoryItem = {
  id: string;
  mediaId: string;
  mediaType: string;
  title: string;
  poster: string | null;
  backdrop: string | null;
  year: string | null;
  rating: number | null;
  source: string;
  progress: number;   // secunde vizionate
  duration: number;   // durată totală cunoscută (0 = necunoscută)
  updatedAt: string;
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
  | "fun" | "lista" | "search" | "universuri" | "showbiz" | "radio"
  | "colectii" | "gestionare";

// FAZA 11 — colecții personale (playlists utilizator, 100% Neon)
export type Collection = {
  id: string;
  name: string;
  description: string;
  isPublic?: boolean;
  itemsCount: number;
  posterUrl: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type CollectionItem = {
  id: number;
  title: string;
  contentType: string;
  provider: string;
  sourceType: string;
  sourceUrl: string | null;
  embedCode: string | null;
  thumbnail: string | null;
  backdrop: string | null;
  year: number | null;
  rating: number;
  views: number;
  signed?: boolean;
  addedAt?: string;
};
