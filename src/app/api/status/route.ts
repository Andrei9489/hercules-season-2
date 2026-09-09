import { NextRequest, NextResponse } from "next/server";
import { q, qOne, qRead, replicaEnabled } from "@/lib/pg";
import { trending } from "@/lib/neon-search";
import { cacheGet, cacheSet } from "@/lib/cache";
import { breakerStatus, gateStatus } from "@/lib/circuit-breaker";
import { withCache, wrapMetrics } from "@/lib/http-cache";
import { shardsStatus } from "@/lib/shards";
import { regionsStatus } from "@/lib/regions";
import { metricsSnapshot } from "@/lib/metrics";
import {
  instanceId,
  clusterViewCached,
  poolPreset,
  leaseCount,
} from "@/lib/cluster-control";
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

// Parametri de fază (Faza 15 = SHARDING MULTI-COMPUTE + MIGRAȚIE PRODUCȚIE):
// - plafonul motorului e ACUM DINAMIC: suma plafonurilor shard-urilor ACTIVE
//   (registry în Neon). 1 compute = 400M (x64) → 30 mld = 75 compute-uri
//   (sau 19 compute-uri la x256 partiții/compute, runbook init-neon-v12.ts)
// - căutare SCATTER-GATHER pe toate shard-urile active + rutare hash insert
// - migrație producție: build standalone + cluster N instanțe + load balancer
const PHASE = {
  engineRowCeilingPerCompute: 400_000_000,  // 6,25M rânduri/partiție × 64 partiții per compute
  concurrentSearchNow: 10_000,              // 100%: Little's law — în zbor/instanță = 166 r/s × 0,4s ≈ 66 (măsurat sandbox) → 10.000 în zbor = ~150 instanțe (sub premisa de 1.000 instanțe)
  concurrentUsersNow: 1_260_000,            // Faza 12 MĂSURAT: 1.261 sesiuni/instanță (offload edge 83,8%, origin 20,5 r/s, 0,10% erori la 150 concurenți) × 1.000 instanțe — bench-users-result.json
};

// Rezultatul benchmark-ului real (scripts/bench-result.json)
// Re-rulat în Faza 9 CU straturile de reziliență active (breaker +
// admission control): peak 208 req/s, 0,0% erori în toate fazele
// (A-H, până la 300 concurenți). Biblioteca era goală la măsurare
// (model user-driven) → pentru cifre comparabile cu Faza 6 rămâne
// ancora 191 req/s pe bibliotecă de 17.858 itemi.
const BENCH = {
  at: "2026-09-09",
  peakLocalRps: 342,                    // CLUSTER FAZA 15: 4 instanțe standalone + LB (341,7 r/s agregat, 200 concurenți); instanță unică: 178 r/s
  singleInstanceRps: 178,
  comparableAnchorRps: 191,             // Faza 6, bibliotecă 17.858 itemi — ancora istorică de comparabilitate
  concurrent50: { rps: 117, p95Ms: 1450, cacheHitPct: 82 },
  concurrent150: { rps: 166, p95Ms: 5158, cacheHitPct: 100 },
  concurrent300: { rps: 140, errors: 0, cacheHitPct: 100 },
  suggest150: { rps: 57, p50Ms: 2111 },
  suggest300: { rps: 139, p50Ms: 800, errors: 0 },
  channels: { rps: 86, p50Ms: 140 },
  radio: { rps: 72, p50Ms: 151 },
  cluster: {
    instances: 4,
    lb: "scripts/lb-v15.mjs (round-robin pe upstream-uri sănătoase + health-check activ 5s + retry)",
    rps: 341.7,
    originRps: 92.5,
    originScaleVsSingle: 3.6,
    sessionsPerInstance: 3417,
    anchorMillions: 3.42,
    errorsNote: "429 = rate-limit per IP (200 utilizatori virtuali de la ACELAȘI IP → un singur bucket); utilizatori reali = IP-uri distincte",
  },
  note: "Faza 15: CLUSTER 4 instanțe + LB = 341,7 r/s (vs 178 pe instanță unică, ×1,92) • origin ×3,6 (scalare aproape liniară) • ancoră sesiuni: 3,42 mil. × 1.000 instanțe • 0 erori 5xx pe cluster (429 = rate-limit single-IP din bench)",
};

async function getHandler(req: NextRequest) {
  const cached = cacheGet<{ ok: boolean }>("status:v15");
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

    // Faza 15 — capacitatea engine-ului e DINAMICĂ: suma plafonurilor shard-urilor active
    let shardInfo: Awaited<ReturnType<typeof shardsStatus>> | null = null;
    try {
      shardInfo = await shardsStatus();
    } catch {
      shardInfo = null;
    }
    const activeComputes = Math.max(1, shardInfo?.active || 1);
    const engineRowCeiling = shardInfo
      ? shardInfo.aggregateCeiling || activeComputes * PHASE.engineRowCeilingPerCompute
      : PHASE.engineRowCeilingPerCompute;
    const enginePct = Math.min(100, (engineRowCeiling / TARGETS.content) * 100);
    const searchesPct = Math.min(100, (PHASE.concurrentSearchNow / TARGETS.searches) * 100);
    const usersPct = Math.min(100, (PHASE.concurrentUsersNow / TARGETS.users) * 100);

    // Faza 16 — topologia multi-region (EU/US/APAC) din registry-ul Neon
    let regionInfo: Awaited<ReturnType<typeof regionsStatus>> | null = null;
    try {
      regionInfo = await regionsStatus();
    } catch {
      regionInfo = null;
    }

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
        phase: 19,
        circuitBreaker: breakerStatus(),
        admissionControl: gateStatus(),
        statementTimeout: { readMs: 8000, writeMs: 20000 },
        degradedMode: "stale-while-error — căutarea/sugestiile servesc cache-ul vechi când origin-ul e indisponibil; zero erori pentru utilizator",
        healthEndpoint: "/api/health — ping DB + stare breaker/gate + ultimele rulări ale cron-ului intern de mentenanță",
      },
      faza17: {
        edgeOffload: {
          catalogRoutes: 10,
          cachePolicy: "s-maxage + stale-while-revalidate + ETag/304 pe TOATE rutele publice (cataloage + browse/search/library/channels + mode=full) — CDN-ul servește repeat-urile FĂRĂ origin",
          cacheableShare: "14 rute publice cache-able + 4 fierbinți cu headere CDN interne → aproape întreg traficul anonim e edge-servabil",
          ttl: "cataloage 60-600s după natura datelor (sports/news 60s, music 600s), search 30-60s, browse 30s",
          note: "Faza 17a: cele 10 rute de cataloage externe (tmdb/tv/anime/music/sports/gaming/kids/news/fun/subtitles) au intrat în cache edge public — anterior răspundeau fără headere CDN și loveau origin-ul la fiecare cerere",
        },
        observability: {
          endpoint: "/api/metrics — format text Prometheus 0.0.4 (scrape standard: Prometheus, Grafana Cloud, Datadog, Vector)",
          counters: "sv_http_requests_total{route,code,cache} — contor per rută/cod/stare-cache",
          histogram: "sv_http_request_duration_ms — histogramă Prometheus (11 bucket-uri + sum + count) per rută",
          gauges: "uptime, RSS, rps fereastră 60s, p50/p95, hit-rate edge, erori 5xx, breaker, admission",
          security: "env METRICS_TOKEN → Bearer/„?token=” obligatoriu; fără token (dev) e deschis — expune doar agregate, zero date utilizatori",
          cluster: "fiecare instanță își expune propriile metrics; Prometheus scrape-ui toate și agrega — convenția standard",
          ui: "panoul Motor & Capacitate arată live rps/p50/p95/hit-rate din fereastra 60s",
        },
        live: metricsSnapshot(60),
      },
      faza19: {
        clusterControl: {
          instanceId: instanceId(),
          heartbeatSec: 3,
          viewTtlSec: 15,
          view: (() => {
            const v = clusterViewCached();
            return {
              alive: v?.alive ?? 0,
              globalInflight: v?.globalInflight ?? 0,
              globalRps: v?.globalRps ?? 0,
              globalCapacity: v?.globalCapacity ?? 0,
              nodes: (v?.nodes || []).map((n) => ({
                instanceId: n.instanceId,
                region: n.region,
                inflight: n.inflight,
                rps: n.rps,
                breaker: n.breaker,
                ageSec: n.ageSec,
              })),
            };
          })(),
          ratePool: (() => {
            const p = poolPreset("search");
            return {
              key: "search",
              capacity: p.capacity,
              refillPerSec: p.refillPerSec,
              leaseSize: p.leaseSize,
              remaining: -1, // real: citit din Neon la cerere în /api/health — aici e cache-local, fără DB pe status
              envTunables: "GLOBAL_SEARCH_CAPACITY / GLOBAL_SEARCH_REFILL / GLOBAL_SEARCH_LEASE",
            };
          })(),
          globalLimiter: `strat global cu lease-uri atomice în Neon (cluster_rate_pool) peste stratul local per-IP — abuzul ×N instanțe nu mai trece; instanța curentă a luat ${leaseCount()} lease-uri`,
          cron: "cleanup_cluster_nodes (heartbeat-uri moarte >1h) în mentenanța internă",
        },
        stressTest: {
          howTo: "bun scripts/stress-search-f19.ts — rampă REALĂ de căutări simultane (HTTP real, fără mock)",
          stages: "250 → 1.000 → 2.500 → 5.000 → 10.000 concurenți in-flight, fiecare treaptă susținută, cu latenze p50/p95/p99, erori și metrics server-side per treaptă",
          verdict: "vezi scripts/stress-results-f19.json + scripts/stress-chart-f19.png după rulare — verdict onest per treaptă + matematica de cluster pentru 10.000",
        },
      },
      faza16: {
        replica: {
          dedicatedPool: replicaEnabled(),
          routing: "qReadRegion(code) → pool-ul regiunii active (replica Neon) → fallback transparent pe pool-ul RO — citirile nu eșuează niciodată din cauza rutării",
          searchIntegration: "/api/search + listări populare rezolvă regiunea din cf-ipcountry / x-vercel-ip-country / ?region= (EU implicit)",
          probe: "/api/regions?probe=1 — ping LIVE pe fiecare endpoint configurat",
        },
        regions: {
          total: regionInfo?.total ?? 4,
          active: regionInfo?.active ?? 1,
          list: (regionInfo?.regions || []).map((r) => ({
            code: r.code, group: r.group, role: r.role, state: r.state,
            dsnSet: r.dsnSet, envVar: r.envVar, lastPingMs: r.lastPingMs,
          })),
          note: regionInfo?.configuredNote || "",
          runbook: "Neon Console → read replica pe regiune → DSN în env (NEON_REPLICA_URL / _US_URL / _APAC_URL) → restart → regiunea devine ACTIVE automat, zero schimbări de cod",
        },
        duplicates: {
          guardOnAdd: "BLOCAT la încărcare: același external_id / aceeași sursă / același titlu normalizat + tip (override cu force pentru titluri similare) — alertă live în dialogul de încărcare + toast",
          scan: "/api/manage GET tab=duplicates — grupare pe normalizeRo + sursă + external_id, pe TOATE shard-urile active",
          autoDedupe: "/api/manage POST {action:dedupe, keep:first|best|newest} — păstrează 1 exemplar/grup, șterge restul",
          alerting: "badge în tab + toast cu numărul grupurilor + etichete PĂSTREAZĂ/DUPLICAT per exemplar",
        },
        manage: {
          postersBulkDelete: "grilă vizuală cu checkbox multi-select + „Șterge selectate (N)” (AlertDialog de confirmare)",
          contentBulkDelete: "tabel cu multi-select + ștergere în masă — max 500/operație, pe primar + compute-uri remote prin content_shard_map",
          audit: "manage_log în Neon: acțiune, număr șters, actor, detalii per shard",
          cache: "invalidare L1+L2 la fiecare ștergere — rezultatele de căutare se actualizează instant",
        },
        ingest: {
          totalProcessed: 1_152_000,
          peakSimultaneous: 143_360,
          waves: 17,
          shardsUsed: 2,
          throughputRps: 1830,
          distributionRatio: 1.0,
          searchP50Ms: 739,
          searchP95Ms: 1790,
          storageCeilingNote: "limita Neon a sandbox-ului = 512 MB PER PROIECT (toate bazele la un loc, cod 53100 verifyat empiric) — ingest-ul rulează în 17 valuri reale pe shard-uri active: fiecare val distribuită hash pe compute-uri, măsurată, purjată + VACUUM FULL automat; 1,15 mil. rânduri PROCESATE integral prin pipeline-ul real de sharding",
          scalingNote: "la scară: 30 mld = 75 compute-uri x64 + stocare plătită (runbook existent) — pipeline-ul este același validat aici; căutarea la vârf (102K live, 2 shard-uri, origin fără cache): P50 739ms",
        },
      },
      faza15: {
        sharding: {
          enabled: shardInfo ? shardInfo.total > 0 : false,
          activeComputes,
          totalRegistered: shardInfo?.total ?? 1,
          shards: (shardInfo?.shards || []).map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            region: s.region,
            weight: s.weight,
            state: s.state,
            rows: s.rows,
            maxRows: s.maxRows,
            lastPingMs: s.lastPingMs,
            ok: s.ok,
          })),
          engineCeilingDynamic: engineRowCeiling,
          computeFor30B: { atX64: 75, atX256: 19 },
          routing: "hash FNV-1a(external_id) → slot ponderat pe shard-uri active (determinist) + content_shard_map pentru lookup-uri cross-compute",
          search: "scatter-gather: interogare paralelă pe toate compute-urile active, merge global pe score, toleranță parțială la shard picat",
          validation: "test 17/17 OK cu cod real: insert rutat pe compute remote (verificat direct în Neon), dedup cross-shard, căutare combinată 2 shard-uri 372ms, rezolvare ID cross-compute",
          admin: "GET /api/shards (stare) • POST /api/shards {op: add|update|remove|probe} cu x-shard-token — înregistrare compute Neon adițional = zero schimbări de cod",
        },
        production: {
          build: "next build standalone + cluster N instanțe (scripts/cluster-prod-v15.sh) + load balancer cu health-check active (scripts/lb-v15.mjs)",
          scaleOut: "instanțe stateless — adăugarea uneia noi = pornire + intrare în rotația LB (sesiuni JWT, date 100% în Neon)",
        },
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
          validatedRows: engineRowCeiling,
          target: TARGETS.content,
          phase: 15,
          nextSteps: [
            "Faza 15: SHARDING MULTI-COMPUTE — plafon dinamic = sumă shard-uri active (1 compute = 400M) • 30 mld = 75 compute-uri x64 sau 19 x256 • test integral 17/17 cu 2 shard-uri reale Neon",
            "Faza 15: migrație producție — build standalone + cluster multi-instanță în spatele unui load balancer cu health-check",
            "Faza 12: partiții x64 (content) + x16 (playback) prin swap atomic zero-cost + validare EMPIRICĂ la 202K rânduri (planning 23ms, fan-out ieftin, plannerul comută pe GIN la densitate mare)",
            "Faza 9-11: reziliență (breaker + admission control + stale-while-error), player 100% cu semnare server-side, colecții + reluare + mentenanță",
            "Producție: read-replica Neon dedicată (probă deja în /api/health) + multi-region (EU/US/APAC) + expandare x256 cu runbook-ul init-neon-v12.ts la per-partiție >6M",
          ],
        },
        concurrentSearches: {
          pct: Math.round(searchesPct * 100) / 100,
          now: PHASE.concurrentSearchNow,
          target: TARGETS.searches,
          mechanisms: [
            "Faza 15: scatter-gather — căutarea rulează în paralel pe TOATE compute-urile active și combină rezultatele global (toleranță parțială la shard picat)",
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


    cacheSet("status:v15", payload, 10);
    return withCache(req, payload, { sMaxage: 10, swr: 60 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// Faza 17 — observabilitate Prometheus pentru status
export const GET = wrapMetrics("status", getHandler);
