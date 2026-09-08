#!/usr/bin/env python3
# Faza 12: patch /api/status — BENCH, cache key v12, db note, resilience, faza12, capacity
p = "/home/z/my-project/src/app/api/status/route.ts"
src = open(p).read()

def replace_once(s, old, new, label):
    i = s.find(old)
    if i < 0:
        raise SystemExit(f"ANCHOR NEGĂSIT: {label}")
    if s.find(old, i + 1) >= 0:
        raise SystemExit(f"ANCHOR DUPLICAT: {label}")
    return s[:i] + new + s[i + len(old):]

# ---- 1. BENCH block (anchor de la const BENCH până la }; înainte de GET) ----
i = src.find("const BENCH = {")
j = src.find("};", i)
j += 2
new_bench = '''const BENCH = {
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
};'''
src = src[:i] + new_bench + src[j:]

# ---- 2. cache keys v11 → v12 ----
src = replace_once(src, 'const cached = cacheGet<{ ok: boolean }>("status:v11");',
                   'const cached = cacheGet<{ ok: boolean }>("status:v12");', "cacheGet v12")
src = replace_once(src, 'cacheSet("status:v11", payload, 10);',
                   'cacheSet("status:v12", payload, 10);', "cacheSet v12")

# ---- 3. db note ----
src = replace_once(src,
  'note: "router READ/WRITE Faza 6 — pool RO dedicat pentru citiri (replica-ready prin NEON_REPLICA_URL)",',
  'note: "Faza 12: content partiționat HASH x64 (expandat din x16 prin swap atomic zero-cost) + playback_events x16 + search_logs RANGE 12 — router READ/WRITE cu probă replică în /api/health",',
  "db note")

# ---- 4. resilience phase ----
src = replace_once(src, "      resilience: {\n        phase: 11,",
                        "      resilience: {\n        phase: 12,", "resilience phase 12")

# ---- 5. faza12 block înainte de userDriven ----
src = replace_once(src, "      userDriven: {", '''      faza12: {
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
      userDriven: {''', "faza12 block")

# ---- 6. capacity block (de la 'capacity: {' până la '};' + cacheSet deja redenumit) ----
i = src.find("      capacity: {")
j = src.find('    };\n\n    cacheSet("status:v12"', i)
if j < 0:
    raise SystemExit("anchor sfârșit capacity negăsit")
new_capacity = '''      capacity: {
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

    cacheSet("status:v12"'''
src = src[:i] + new_capacity + src[j + len('    };'):]
# curățăm restul vechiului cacheSet rămas după înlocuirea capacității
# (segmentul dintre noul 'cacheSet("status:v12"' și vechiul conținut)
tail_marker = 'cacheSet("status:v12"'
k = src.find(tail_marker)
old_tail = src.find('cacheSet("status:v12", payload, 10);', k)
# dacă după noul marker există alt ', payload, 10);' dublat, eliminăm
after = src[k + len(tail_marker): k + len(tail_marker) + 40]
open(p, "w").write(src)
print("Status patch aplicat. Context final cacheSet:", repr(after[:40]))
