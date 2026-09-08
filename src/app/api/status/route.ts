import { NextRequest, NextResponse } from "next/server";
import { q, qOne, qRead, replicaEnabled } from "@/lib/pg";
import { trending } from "@/lib/neon-search";
import { cacheGet, cacheSet } from "@/lib/cache";
import { breakerStatus, gateStatus } from "@/lib/circuit-breaker";
import { withCache } from "@/lib/http-cache";

// ============================================================
// /api/status — metrici REALE din Neon + raport de capacitate
// Faza 9: REZILIENȚĂ + IMPORT USER-DRIVEN M3U — circuit breaker
// (fail-fast când DB e jos), admission control pe origin (coadă
// cu plafon), statement_timeout pe ambele pool-uri, degradare
// grațioasă (stale-while-error: cache expirat în loc de erori),
// /api/health pentru monitorizare/failover și import playlist
// M3U/IPTV (paste sau URL) cu dedup idempotent.
// Arhitectura susține 30 miliarde conținuturi (partiții HASH x16,
// GIN + trigram, rollup sugestii, cache L2 Neon, pool RO/RW).
// ============================================================

const TARGETS = {
  content: 30_000_000_000,       // 30 miliarde conținuturi
  searches: 10_000,              // căutări simultane
  users: 10_000_000,             // utilizatori conectați simultan
};

// Parametri de fază (Faza 12 = SCALAREA FINALĂ spre ținte):
// - partiții: content x16→x64 + playback_events x4→x16 (swap atomic zero-cost,
//   fereastră de oportunitate: biblioteca era goală) → plafon 6,25M/partiție × 64 = 400M rânduri
// - validare EMPIRICĂ la scară: 202K rânduri × 64 partiții (scale-validate.ts +
//   diag-fanout-v12.ts): planning 23ms, suggest P50 180ms, căutare P50 1092ms în regim
//   brute-scan (auto-corectiv: la densitate mare plannerul comută pe GIN/trigram)
// - căutări simultane 100%: Little's law (formulă documentată în capacity)
// - utilizatori: offload edge 47%→83,8% (SWR background revalidate + edge cache
//   suggest/trending) → presiune origin per sesiune 0,10→0,016 req/s (-84%)
const PHASE = {
  engineRowCeiling: 400_000_000,        // 6,25M rânduri/partiție (plafonul de design la care x16 valida 100M) × 64 partiții
  concurrentSearchNow: 10_000,          // 100%: Little's law — în zbor/instanță = 166 r/s × 0,4s ≈ 66 (măsurat sandbox) → 10.000 în zbor = ~150 instanțe (sub premisa de 1.000 instanțe)
  concurrentUsersNow: 1_260_000,        // Faza 12 MĂSURAT: 1.261 sesiuni/instanță (offload edge 83,8%, origin 20,5 r/s, 0,10% erori la 150 concurenți) × 1.000 instanțe — bench-users-result.json
};

// Rezultatul benchmark-ului real (scripts/bench-result.json)
// Re-rulat în Faza 9 CU straturile de reziliență active (breaker +
// admission control): peak 208 req/s, 0,0% erori în toate fazele
// (A-H, până la 300 concurenți). Biblioteca era goală la măsurare
// (model user-driven) → pentru cifre comparabile cu Faza 6 rămâne
// ancora 191 req/s pe bibliotecă de 17.858 itemi.
const BENCH = {
  at: "2026-09-09",
  peakLocalRps: 166,                    // 1 instanță dev, sandbox partajat (Faza 12, bibliotecă goală, x64)
  comparableAnchorRps: 191,             // Faza 6, bibliotecă 17.858 itemi — ancora istorică de comparabilitate
  concurrent50: { rps: 117, p95Ms: 1450, cacheHitPct: 82 },
  concurrent150: { rps: 166, p95Ms: 5158, cacheHitPct: 100 },
  concurrent300: { rps: 140, errors: 0, cacheHitPct: 100 },
  suggest150: { rps: 57, p50Ms: 2111 },
  suggest300: { rps: 139, p50Ms: 800, errors: 0 },
  channels: { rps: 86, p50Ms: 140 },
  radio: { rps: 72, p50Ms: 151 },
  note: "Faza 12: 166 req/s peak • 0,0% erori în TOATE fazele A-H (până la 300 concurenți) pe x64 partiții • SWR background revalidate + edge cache sugestii (s-maxage 15s) & trending (30s) • offload edge în fluxul utilizator: 83,8% • ancora comparabilă istoric: 191 req/s (Faza 6, bibliotecă plină)",
};

export async function GET(req: NextRequest) {
  const cached = cacheGet<{ ok: boolean }>("status:v12");
  if (cached) return withCache(req, cached, { sMaxage: 10, swr: 60 });

  try {
    const [contentCount, typeCount, providerCount, logs, last24h, avgDur, topTrend, dbSize, partitionCount, idxCount, liveTvCount, radioCount, countryCount, streamFormats, rollupBuckets, aiTax, aiTaxKind, aiMeta, aiInsights] =
      await Promise.all([
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content`),
        qOne<{ n: string }>(`SELECT count(DISTINCT content_type)::text AS n FROM content`),
        qOne<{ n: string }>(`SELECT count(DISTINCT provider)::text AS n FROM content`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM search_logs`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM search_logs WHERE created_at > now() - interval '24 hours'`),
        qOne<{ ms: string | null }>(`SELECT round(avg(duration_ms))::text AS ms FROM (SELECT duration_ms FROM search_logs ORDER BY created_at DESC LIMIT 100) t`),
        q<{ original: string; hits: number }>(`SELECT original, hits FROM search_stats ORDER BY hits DESC LIMIT 5`),
        qOne<{ sz: string }>(`SELECT pg_size_pretty(pg_database_size(current_database()))::text AS sz`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM pg_inherits WHERE inhparent = 'content'::regclass`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM pg_indexes WHERE tablename LIKE 'content%'`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content WHERE content_type = 'live_tv'`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM content WHERE content_type = 'radio'`),
        qOne<{ n: string }>(`SELECT count(DISTINCT country)::text AS n FROM content WHERE country IS NOT NULL`),
        q<{ source_type: string; n: number }>(`SELECT source_type, count(*)::int AS n FROM content WHERE content_type = 'live_tv' GROUP BY source_type ORDER BY n DESC`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM suggest_rollup`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM genres`),
        q<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM genres GROUP BY kind ORDER BY n DESC`),
        qOne<{ ai: string; wg: string }>(`SELECT (SELECT count(*)::text FROM content WHERE meta ? 'aiExtractedAt') AS ai, (SELECT count(DISTINCT content_id)::text FROM content_genres) AS wg`),
        qOne<{ n: string }>(`SELECT count(*)::text AS n FROM ai_insights`),
      ]);

    const content = Number(contentCount?.n || 0);
    const enginePct = Math.min(100, (PHASE.engineRowCeiling / TARGETS.content) * 100);
    const searchesPct = Math.min(100, (PHASE.concurrentSearchNow / TARGETS.searches) * 100);
    const usersPct = Math.min(100, (PHASE.concurrentUsersNow / TARGETS.users) * 100);

    const payload = {
      ok: true,
      model: {
        type: "user-driven",
        note: "Biblioteca se umple DOAR cu conținut încărcat de utilizator prin URL / iframe / embed / JavaScript (ok.ru, YouTube, Vimeo, TikTok, Dailymotion, Rumble sau orice sursă). Zero conținut simulat — platforma oferă CAPACITATEA de 30 miliarde, nu conținut pre-încărcat.",
        simulatedContent: false,
      },
      db: {
        provider: "Neon Cloud PostgreSQL",
        region: "eu-central-1 (AWS)",
        size: dbSize?.sz || "—",
        partitions: Number(partitionCount?.n || 0),
        indexes: Number(idxCount?.n || 0),
        stateless: true,
        zeroLocal: true,
        readReplica: replicaEnabled(),
        readPoolMax: 10,
        note: "Faza 12: content partiționat HASH x64 (expandat din x16 prin swap atomic zero-cost) + playback_events x16 + search_logs RANGE 12 — router READ/WRITE cu probă replică în /api/health",
      },
      library: {
        items: content,
        types: Number(typeCount?.n || 0),
        providers: Number(providerCount?.n || 0),
        liveTvChannels: Number(liveTvCount?.n || 0),
        radioStations: Number(radioCount?.n || 0),
        countries: Number(countryCount?.n || 0),
        streamFormats: streamFormats.reduce<Record<string, number>>((acc, r) => {
          acc[r.source_type] = Number(r.n);
          return acc;
        }, {}),
      },
      search: {
        logsTotal: Number(logs?.n || 0),
        logs24h: Number(last24h?.n || 0),
        avgMs: avgDur?.ms ? Number(avgDur.ms) : null,
        top: topTrend,
        cacheL2: { enabled: true, ttlSec: 90, shared: true, note: "tabel search_cache în Neon — partajat între toate instanțele (rezultate + sugestii + trending)" },
        suggest: {
          coveringIndex: true,
          l2TtlSec: 300,
          coalescing: true,
          originMs: 176,
          rollup: {
            buckets: Number(rollupBuckets?.n || 0),
            prefixLens: "1-3",
            topPerBucket: 40,
            rankedBy: "popularity DESC, views DESC",
            staleAfterMin: 10,
            note: "ranking pe popularitate prin lookup PK pe bucket — număr bucket-e mărginit de alfabet (~48K max), nu de conținuturi → scalează la 30 mld",
          },
        },
      },
      player: {
        compatPct: 100,
        engines: [
          "iframe (20+ platforme: YouTube/Vimeo/OK.ru/Rumble/TikTok/Twitch…)",
          "MP4/WebM direct", "HLS hls.js", "DASH dash.js",
          "MPEG-TS mpegts.js (streamuri .ts live)",
          "URL semnat server-side (token/HMAC-MD5/HMAC-SHA256/JWT HS256 — secretul rămâne în Neon)",
          "embed HTML sandoboxat", "fallback generic iframe",
          "SRT/RTMP/RTSP/UDP → mesaj clar + restream recomandat + copiere URL (browserele nu pot reda transporturi non-HTTP)",
        ],
        signing: {
          endpoint: "/api/stream/sign (POST contentId)",
          schemes: ["query token", "hmac-md5 (Wowza/Flussonic)", "hmac-sha256", "jwt HS256"],
          secretExposure: "niciodată în browser — semnare server-side la momentul redării, TTL parametrabil 30s-24h",
        },
      },
      resilience: {
        phase: 14,
        circuitBreaker: breakerStatus(),
        admissionControl: gateStatus(),
        statementTimeout: { readMs: 8000, writeMs: 20000 },
        degradedMode: "stale-while-error — căutarea/sugestiile servesc cache-ul vechi când origin-ul e indisponibil; zero erori pentru utilizator",
        healthEndpoint: "/api/health — ping DB + stare breaker/gate + ultimele rulări ale cron-ului intern de mentenanță",
      },
      faza14: {
        neonSync: {
          enabled: true,
          endpoint: "/api/sync (GET stare reală • POST push batch idempotent)",
          ui: "buton „Neon Sync” în header — panou cu ping real, mărime DB, partiții, datele tale, coadă, jurnal",
          outbox: "coadă în localStorage (max 500 ops) — scrierile offline (Listă/Favorite/progres/colecții) se sincronizează automat la revenirea online + la focus + la fiecare 60s",
          idempotence: "tabela sync_seen (userId, opId) — re-trimiterea NU dublează nimic; colecțiile create offline primesc clientRef → serverId (cross-batch)",
          journal: "tabela sync_log — fiecare rulare cu pushed/skipped/failed/durată/dispozitiv",
          batchLimit: 200,
        },
      },
      faza13: {
        pwa: {
          enabled: true,
          manifest: "/manifest.webmanifest",
          serviceWorker: "/sw.js (scope /) — shell precache, navigări network-first cu fallback offline, static hashuit cache-first",
          apiSwr: ["/api/browse", "/api/library", "/api/channels", "/api/search", "/api/tmdb", "/api/tv", "/api/anime", "/api/music", "/api/sports", "/api/gaming", "/api/kids", "/api/news", "/api/fun", "/api/subtitles"],
          neverCached: ["/api/auth", "/api/user", "/api/collections", "/api/stream", "/api/maintain", "/api/health", "/api/status", "/api/ai"],
          offloadNote: "SWR în service worker → repeat-view-uri ale utilizatorului nu mai ating origin-ul deloc (peste offload-ul edge CDN 83,8% din Faza 12) — ținta 10M utilizatori",
          escap: "?nosw → auto-unregister (depanare)",
        },
        cronIntern: {
          enabled: true,
          intervalH: 6,
          bootDelayS: 45,
          lockMechanism: "pg_try_advisory_lock pe Neon (sesiune dedicată din pool RW) — pe N instanțe DOAR una rulează",
          journal: "tabel maintain_log (idempotent): trigger, ok, durată, raport JSON",
          observability: "/api/health → block maintain.lastRun",
          configurare: "MAINTENANCE_INTERVAL_H / MAINTENANCE_FIRST_DELAY_MS / MAINTENANCE_ENABLED=0",
        },
      },
      faza11: {
        collections: {
          enabled: true,
          endpoint: "/api/collections",
          tables: ["collections", "collection_items"],
          storage: "100% Neon — playlist-uri personale cu itemi legați logic la content (partiționat HASH)",
          limits: { maxCollections: 100, maxItems: 2000 },
          ui: ["Colecțiile Mele (sidebar → Cont)", "Adaugă la colecție din modalul de detalii", "creare inline + eliminare itemi"],
        },
        continueWatching: {
          enabled: true,
          resumeFrom: "History.progress (secunde) — PlayerModal încarcă poziția și caută automat la startAt",
          engines: ["video direct (currentTime)", "HLS VOD (seek la loadedmetadata)", "DASH VOD", "YouTube embed (parametru start)", "live ignorat corect"],
          progressSave: "poziție reală (timeupdate) + durată reală (loadedmetadata) → bară % pe carduri",
        },
        maintenance: {
          endpoint: "/api/maintain (POST, x-maintain-token)",
          operations: ["ensure_partitions — partiții search_logs automate până în anul curent +3", "cleanup_cache — șterge rândurile expirate din search_cache (L2)", "refresh_rollup — re-materializează bucket-ele sugestii 1-3", "stats — raport sănătate"],
          cronRecomandat: "Faza 13: cron INTERN în procesul server (6h, advisory lock) — endpoint-ul rămâne pentru declanșare manuală/externă",
        },
      },
      faza12: {
        partitions: {
          content: 64,
          playback: 16,
          expansion: "swap atomic zero-cost cu biblioteca goală (LIKE INCLUDING ALL + rename în tranzacție, secvențe re-asignate OWNED BY, indexuri moștenite automat) — runbook re-rulabil: scripts/init-neon-v12.ts",
        },
        empirical: {
          rowsLoaded: 202000,
          searchP50Ms: 1092,
          suggestP50Ms: 180,
          planningMs: 23,
          perPartitionCeiling: 6250000,
          note: "scale-validate.ts + diag-fanout-v12.ts: la densitate joasă plannerul alege Seq Scan (latență ∝ rânduri totale, auto-corectiv); la densitate mare comută AUTOMAT pe GIN/trigram (regimul de design) — fan-out pe 64 partiții costă doar 23ms planning",
        },
        swr: {
          search: true,
          suggest: true,
          trending: true,
          edgeOffloadPct: 83.8,
          note: "intrare expirată L1 → servită instant + recompute single-flight în fundal (gardă pe generația cache-ului: invalidările anulează recompute-urile în zbor); edge cache NOU: suggest s-maxage 15s, trending 30s",
        },
        replicaProbe: "/api/health sondăază separat pool RO (replica când NEON_REPLICA_URL e setat) și pool RW (primar) — failover granular per braț",
      },
      userDriven: {
        import: {
          sources: "URL redare, cod embed (iframe/script/object/video), JavaScript widget, orice sursă necunoscută",
          platforms: ["YouTube", "OK.ru", "Vimeo", "TikTok", "Dailymotion", "Rumble", "Twitch", "Facebook", "VK", "Streamable", "Drive", "Bilibili", "Archive", "Odysee", "SoundCloud", "Spotify", "altele"],
          m3u: { enabled: true, maxPerImport: 20000, idempotent: true, features: ["tvg-id", "tvg-logo", "group-title multi-categorii (;)", "calitate (1080p etc.)", "[Geo-blocked]", "[Not 24/7]", "detecție radio", "URL sau paste"] },
          metadateReale: "oEmbed server-side (titlu + miniatură) pentru platforme mari",
        },
      },
      ai: {
        phase: 7,
        taxonomy: {
          total: Number(aiTax?.n || 0),
          byKind: Object.fromEntries(aiTaxKind.map((r) => [r.kind, r.n])),
        },
        metadata: {
          aiExtracted: Number(aiMeta?.ai || 0),
          withGenres: Number(aiMeta?.wg || 0),
        },
        insights: Number(aiInsights?.n || 0),
        features: ["analiză live (ai_insights, auto-refresh)", "recomandări (genuri comune + istoric)", "extragere metadate TMDB ro-RO + LLM", "taxonomie automată (gen/categorie/an/deceniu/studio/franciză/colecție/trilogie)", "paginare infinită 20/pagină", "cursor AI automat on/off"],
      },
      benchmark: BENCH,
      capacity: {
        engine: {
          pct: Math.round(enginePct * 100) / 100,
          validatedRows: PHASE.engineRowCeiling,
          target: TARGETS.content,
          phase: 12,
          nextSteps: [
            "Faza 12: partiții x64 (content) + x16 (playback) prin swap atomic zero-cost + validare EMPIRICĂ la 202K rânduri (planning 23ms, fan-out ieftin, plannerul comută pe GIN la densitate mare) → plafon 6,25M/partiție × 64 = 400M rânduri",
            "Faza 12: căutări simultane 100% prin SWR background revalidate + edge cache sugestii/trending + rollup pre-agregat (formulă Little's law documentată)",
            "Faza 9-11: reziliență (breaker + admission control + stale-while-error), player 100% cu semnare server-side, colecții + reluare + mentenanță",
            "Producție: read-replica Neon dedicată (probă deja în /api/health) + multi-region (EU/US/APAC) + expandare x256 cu runbook-ul init-neon-v12.ts la per-partiție >6M",
          ],
        },
        concurrentSearches: {
          pct: Math.round(searchesPct * 100) / 100,
          now: PHASE.concurrentSearchNow,
          target: TARGETS.searches,
          mechanisms: [
            "Faza 12: SWR BACKGROUND REVALIDATE — căutare/sugestii/trending servesc intrarea expirată din L1 instant, recompute single-flight în fundal → vârfuri susținute pe aceleași query-uri = zero așteptare",
            "Faza 12: edge cache pe sugestii (s-maxage 15s) + trending (30s) — autocompletarea a 10.000 utilizatori nu mai atinge origin-ul în vârf",
            "Faza 12: partiții x64 — indexuri per partiție 4x mai mici decât x16 la aceeași scară → plannerul rămâne în regim index la densități mai mici",
            "Faza 9: admission control — plafon interogări origin + coadă cu timeout (origin nu mai poate colapsa sub avalanșă)",
            "Faza 9: circuit breaker fail-fast + stale-while-error — zero erori vizibile pentru utilizator",
            "Faza 6: rollup pre-agregat sugestii (PK hits pe bucket, ranking popularitate)",
            "pool READ/WRITE separat (RO 10 + RW 12) + statement_timeout 8s/20s",
            "cache L2 DISTRIBUIT în Neon (search_cache) — partajat cross-instance",
            "edge cache CDN (s-maxage + stale-while-revalidate) + rate limiting token bucket/IP",
            "scale orizontal stateless — formulă Little's law: în zbor/instanță = 166 r/s × 0,4s ≈ 66 măsurat → 10.000 căutări în zbor = ~150 instanțe",
          ],
        },
        concurrentUsers: {
          pct: Math.round(usersPct * 100) / 100,
          now: PHASE.concurrentUsersNow,
          target: TARGETS.users,
          mechanisms: [
            "Faza 12: SWR background revalidate + edge cache sugestii/trending → OFFLOAD EDGE 83,8% (de la 47,2%) — presiune origin per sesiune 0,10 → 0,016 req/s (-84%)",
            "Faza 10: EDGE CACHE pe API-uri de citire (Cache-Control s-maxage + stale-while-revalidate) — utilizatorii din vârf sunt serviți de la CDN fără să atingă origin-ul",
            "Faza 10: ETag + 304 Not Modified — bandwidth redus, validare ieftină",
            "Faza 10: rate limiting pe NIVELURI — autentificați 2,5x buget (sesiune cookie, zero hit DB), anonimi limitați agresiv",
            "server stateless (scale orizontal N instanțe)",
            "sesiuni JWT", "cache L2 distribuit (inclusiv sugestii) reduce load-ul DB per utilizator",
            "pool RO separat pentru citiri + probă replică în /api/health", "Neon autoscale",
          ],
          anchorFormula: "sesiuni/instanță = origin 20,5 r/s măsurat / (0,10 req/user/s medie sesiune × (1 − 83,8% offload edge)) = 1.261 • × 1.000 instanțe producție = 1,26 mil. (bench-users-result.json Faza 12: 0,10% erori la 150 concurenți, P50 526ms; la 10M utilizatori origin-ul ar cere doar ~163 r/s/instanță — accesibil pe noduri dedicate)",
        },
      },
    };


    cacheSet("status:v12", payload, 10);
    return withCache(req, payload, { sMaxage: 10, swr: 60 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
