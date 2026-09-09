// ============================================================
// FAZA 19a — CONTROL DISTRIBUIT DE CLUSTER (stare partajată în Neon)
// ============================================================
// Până la Faza 18, rate-limit și admission control au fost PER-INSTANȚĂ
// (in-process). La N instanțe în spatele load balancer-ului (ținta
// 10 mil. utilizatori), un abuzator ×N trecea de plafon, iar „câte
// interogări are clusterul în zbor acum" nu era cunoscut global.
// Faza 19 aduce STRATUL DISTRIBUIT REAL, cu Neon ca sursă de adevăr:
//
//  1. RATE-LIMIT GLOBAL CU LEASE-URI (token bucket distribuit):
//     • Neon deține rezerva globală: cluster_rate_pool(key, capacity, tokens)
//     • instanța LEASE-UIEȘTE pachete de tokeni printr-un UPDATE atomic
//       (refil proporțional + consum în ACEEAȘI expresie — fără race-uri
//       de suprascriere); calea rapidă rămâne in-memory (zero DB pe cerere)
//     • pachet epuizat → re-lease; rezervă globală goală → DEGRADARE
//       CONTROLATĂ pe plafonul local (protecția nu scade niciodată sub
//       limita locală; nu există niciodată „fără limită")
//     • back-off la rezervă goală (nu martelăm Neon când e secat)
//
//  2. HEARTBEAT DE CLUSTER: fiecare instanță publică la 3s în
//     cluster_nodes (inflight, rps, breaker, max_inflight) → vederea
//     GLOBALĂ = suma nodurilor proaspete (<15s) → /api/status +
//     gauge-uri Prometheus (sv_cluster_*) + panoul UI. La pica Neon,
//     heartbeat-ul e ignori (fire-and-forget), platforma continuă.
//
//  3. CRON: op „cleanup_cluster_nodes" în maintenance (rânduri moarte).
// ============================================================
import { q, qRead, withRwClient } from "./pg";
import { rateLimit } from "./rate-limit";
import { breakerStatus, gateStatus } from "./circuit-breaker";
import { metricsSnapshot } from "./metrics";

// ---------- Schema (idempotentă) ----------

const DDL = [
  `CREATE TABLE IF NOT EXISTS cluster_rate_pool (
     key text PRIMARY KEY,
     capacity integer NOT NULL,
     tokens integer NOT NULL,
     refill_per_sec numeric NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS cluster_nodes (
     instance_id text PRIMARY KEY,
     region text NOT NULL DEFAULT 'eu-central-1',
     inflight integer NOT NULL DEFAULT 0,
     max_inflight integer NOT NULL DEFAULT 0,
     rps numeric NOT NULL DEFAULT 0,
     breaker text NOT NULL DEFAULT 'closed',
     booted_at timestamptz NOT NULL DEFAULT now(),
     seen_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS cluster_nodes_seen_idx ON cluster_nodes (seen_at)`,
];

const g = globalThis as unknown as {
  __clusterSchema?: Promise<number>;
  __clusterInstance?: string;
  __clusterHeartbeat?: boolean;
  __clusterView?: ClusterView;
  __clusterPoolEmptyUntil?: Map<string, number>;
  __clusterLeases?: Map<string, { tokens: number; lastLeaseAt: number }>;
  __clusterLeaseCount?: number;
};

export async function ensureClusterSchema(): Promise<number> {
  if (!g.__clusterSchema) {
    g.__clusterSchema = (async () => {
      let ok = 0;
      for (const stmt of DDL) {
        try {
          await q(stmt);
          ok++;
        } catch (e) {
          console.error("[cluster] DDL eșuat:", String(e).slice(0, 160));
        }
      }
      return ok;
    })();
  }
  return g.__clusterSchema;
}

// ---------- Identitatea instanței ----------

export function instanceId(): string {
  if (!g.__clusterInstance) {
    const host = process.env.HOSTNAME || "local";
    const nonce = Math.random().toString(36).slice(2, 8); // distinge HMR/restart
    g.__clusterInstance = `${host}:${process.pid}:${nonce}`;
  }
  return g.__clusterInstance;
}

// ---------- 1. Rate-limit global cu lease-uri ----------

export type RatePoolPreset = {
  capacity: number; // burst global maxim (tokeni)
  refillPerSec: number; // ritm susținut global (tokeni/sec)
  leaseSize: number; // cât ia o instanță per lease
};

/**
 * Rezervele globale ale platformei (env-suprascriabil).
 * Semantica reală: cât origin poate absorbi cluster-wide.
 *   search  → ținta 10.000 căutări simultane: burst 4.000 (coada LB),
 *             refil 1.500/s = buget origin susținut cluster (edge-ul
 *             absoarbe restul — Faza 17 a dovedit 85% offload).
 */
export function poolPreset(key: string): RatePoolPreset {
  if (key === "search") {
    return {
      capacity: Number(process.env.GLOBAL_SEARCH_CAPACITY) || 4_000,
      refillPerSec: Number(process.env.GLOBAL_SEARCH_REFILL) || 1_500,
      leaseSize: Number(process.env.GLOBAL_SEARCH_LEASE) || 250,
    };
  }
  if (key === "suggest") {
    return { capacity: 2_000, refillPerSec: 800, leaseSize: 150 };
  }
  // browse / default
  return { capacity: 3_000, refillPerSec: 1_200, leaseSize: 200 };
}

export type GlobalRateResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
  source: "lease" | "lease-refill" | "local-fallback" | "pool-empty";
};

const EMPTY_BACKOFF_MS = 2_000; // rezervă goală → nu re-încercăm DB atât de dev

function leases(): Map<string, { tokens: number; lastLeaseAt: number }> {
  if (!g.__clusterLeases) g.__clusterLeases = new Map();
  return g.__clusterLeases;
}

function emptyUntil(): Map<string, number> {
  if (!g.__clusterPoolEmptyUntil) g.__clusterPoolEmptyUntil = new Map();
  return g.__clusterPoolEmptyUntil;
}

/**
 * Lease atomic din rezerva globală — contabilitate EXACTĂ:
 * tranzacție cu row-lock în care
 *   1) refil proporțional cu timpul scurs (sau creare idempotentă),
 *   2) granted = min(want, disponibil), calculat exact,
 *   3) scriem tokenii rămași. Fără race-uri între instanțe: fila e
 *      blocată de la primul UPDATE până la COMMIT.
 */
export async function leaseFromPool(
  key: string,
  want: number
): Promise<{ granted: number; remaining: number }> {
  await ensureClusterSchema();
  return withRwClient(async (c) => {
    await c.query("BEGIN");
    try {
      const ref = await c.query(
        `UPDATE cluster_rate_pool
           SET tokens = LEAST(capacity, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * refill_per_sec)::int,
               updated_at = now()
         WHERE key = $1
         RETURNING tokens, capacity`,
        [key]
      );
      let avail: number;
      if (!ref.rows.length) {
        const preset = poolPreset(key);
        const ins = await c.query(
          `INSERT INTO cluster_rate_pool (key, capacity, tokens, refill_per_sec)
           VALUES ($1, $2, $2, $3)
           ON CONFLICT (key) DO UPDATE SET updated_at = now()
           RETURNING tokens, capacity`,
          [key, preset.capacity, preset.refillPerSec]
        );
        avail = Number(ins.rows[0].tokens);
      } else {
        avail = Number(ref.rows[0].tokens);
      }
      const granted = Math.min(want, Math.max(0, avail));
      const upd = await c.query(
        `UPDATE cluster_rate_pool SET tokens = $2, updated_at = now() WHERE key = $1 RETURNING tokens`,
        [key, Math.max(0, avail - granted)]
      );
      await c.query("COMMIT");
      return { granted, remaining: Number(upd.rows[0].tokens) };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}

/**
 * STRATUL GLOBAL DE RATE-LIMIT — apelat de rutele fierbinți (search,
 * suggest) ÎNAINTE de stratul local per-IP. Calea rapidă: lease local
 * în memorie (zero DB). Refill: lease atomic din Neon. Rezervă goală
 * sau Neon picat: fallback pe plafonul local per-instanță.
 */
export async function globalRateLimit(
  key: string,
  opts: { burst?: number; perMinute?: number } = {}
): Promise<GlobalRateResult> {
  const now = Date.now();

  // 1. cale rapidă: tokeni din lease-ul local
  const lb = leases().get(key);
  if (lb && lb.tokens >= 1) {
    lb.tokens -= 1;
    return { ok: true, remaining: Math.floor(lb.tokens), retryAfterSec: 0, source: "lease" };
  }

  // 2. back-off: rezerva a fost goală recent → nu mai lovim DB acum
  const until = emptyUntil().get(key) || 0;
  if (now < until) {
    return fallbackLocal(key, opts, "pool-empty");
  }

  // 3. lease atomic din Neon
  const preset = poolPreset(key);
  try {
    const { granted, remaining } = await leaseFromPool(key, preset.leaseSize);
    g.__clusterLeaseCount = (g.__clusterLeaseCount || 0) + 1;
    if (granted >= 1) {
      leases().set(key, { tokens: granted - 1, lastLeaseAt: now });
      emptyUntil().delete(key);
      return {
        ok: true,
        remaining: Math.max(0, granted - 1),
        retryAfterSec: 0,
        source: lb ? "lease-refill" : "lease",
      };
    }
    // rezervă globală goală → back-off + fallback local
    emptyUntil().set(key, now + EMPTY_BACKOFF_MS);
    return fallbackLocal(key, opts, "pool-empty");
  } catch {
    // Neon indisponibil → degradare controlată pe plafonul local
    return fallbackLocal(key, opts, "local-fallback");
  }
}

function fallbackLocal(
  key: string,
  opts: { burst?: number; perMinute?: number },
  source: "local-fallback" | "pool-empty"
): GlobalRateResult {
  // plafon local mai strâns decât presetările obișnuite: protejează
  // instanța chiar și când distribuția globală nu e disponibilă
  const r = rateLimit(`cluster:${instanceId()}:${key}`, {
    burst: opts.burst ?? 120,
    perMinute: opts.perMinute ?? 240,
  });
  return {
    ok: r.ok,
    remaining: r.remaining,
    retryAfterSec: r.retryAfterSec,
    source,
  };
}

/** Telemetrie: câte lease-uri a luat această instanță (viata procesului). */
export function leaseCount(): number {
  return g.__clusterLeaseCount || 0;
}

// ---------- 2. Heartbeat + vedere globală ----------

export type ClusterNodeRow = {
  instanceId: string;
  region: string;
  inflight: number;
  maxInflight: number;
  rps: number;
  breaker: string;
  bootedAt: string | null;
  ageSec: number;
};

export type ClusterView = {
  alive: number;
  globalInflight: number;
  globalRps: number;
  globalCapacity: number; // maxConcurrent × instanțe vii (buget origin global)
  nodes: ClusterNodeRow[];
  viewTtlSec: number;
  at: string;
};

export const VIEW_TTL_SEC = 15;

/** Publică starea instanței în Neon + reîmprospătează vederea globală. */
export async function heartbeatOnce(): Promise<ClusterView | null> {
  const snap = metricsSnapshot(10);
  const b = breakerStatus();
  const gt = gateStatus();
  const region = process.env.REGION_NAME || "eu-central-1";
  try {
    await q(
      `INSERT INTO cluster_nodes (instance_id, region, inflight, max_inflight, rps, breaker)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (instance_id) DO UPDATE SET
         region = EXCLUDED.region,
         inflight = EXCLUDED.inflight,
         max_inflight = GREATEST(cluster_nodes.max_inflight, EXCLUDED.max_inflight),
         rps = EXCLUDED.rps,
         breaker = EXCLUDED.breaker,
         seen_at = now()`,
      [
        instanceId(),
        region,
        gt.inFlight,
        gt.maxObserved,
        snap.rps,
        b.state,
      ]
    );
  } catch {
    // Neon indisponibil → heartbeat ignorat, platforma continuă
  }
  return refreshClusterView();
}

/** Vederea globală = suma nodurilor proaspete (<15s). */
export async function refreshClusterView(forceSchema = false): Promise<ClusterView> {
  if (forceSchema) await ensureClusterSchema();
  try {
    const rows = await qRead<Record<string, unknown>>(
      `SELECT instance_id, region, inflight, max_inflight, rps, breaker, booted_at,
              EXTRACT(EPOCH FROM (now() - seen_at)) AS age
       FROM cluster_nodes
       WHERE seen_at > now() - interval '${VIEW_TTL_SEC} seconds'
       ORDER BY instance_id`
    );
    const nodes: ClusterNodeRow[] = rows.map((r) => ({
      instanceId: String(r.instance_id),
      region: String(r.region),
      inflight: Number(r.inflight) || 0,
      maxInflight: Number(r.max_inflight) || 0,
      rps: Number(r.rps) || 0,
      breaker: String(r.breaker),
      bootedAt: r.booted_at ? new Date(r.booted_at as string).toISOString() : null,
      ageSec: Math.round(Number(r.age) * 10) / 10,
    }));
    const view: ClusterView = {
      alive: nodes.length,
      globalInflight: nodes.reduce((s, n) => s + n.inflight, 0),
      globalRps: Math.round(nodes.reduce((s, n) => s + n.rps, 0) * 100) / 100,
      globalCapacity: nodes.length * gateStatus().maxConcurrent,
      nodes,
      viewTtlSec: VIEW_TTL_SEC,
      at: new Date().toISOString(),
    };
    g.__clusterView = view;
    return view;
  } catch {
    // la eroare returnăm ultima vedere cunoscută (sau una goală)
    return (
      g.__clusterView || {
        alive: 0,
        globalInflight: 0,
        globalRps: 0,
        globalCapacity: 0,
        nodes: [],
        viewTtlSec: VIEW_TTL_SEC,
        at: new Date().toISOString(),
      }
    );
  }
}

/** Vederea din cache (fără DB) — pentru gauge-uri sincrone / status. */
export function clusterViewCached(): ClusterView | null {
  return g.__clusterView ?? null;
}

/** Buclă de heartbeat — pornită o dată per proces (idempotent la HMR). */
export function startClusterHeartbeat(intervalMs = 3_000): void {
  if (g.__clusterHeartbeat) return;
  g.__clusterHeartbeat = true;
  const tick = async () => {
    try {
      await heartbeatOnce();
    } catch {
      /* niciodată aruncată */
    }
  };
  const timer = setInterval(() => void tick(), Math.max(1_000, intervalMs));
  timer.unref?.();
  void tick(); // prima publicare imediat după boot
  console.log(`[cluster] heartbeat pornit (${instanceId()}, la fiecare ${Math.round(intervalMs / 1000)}s)`);
}

// ---------- 3. Gauge-uri Prometheus (sincrone, din cache) ----------

export function renderClusterGauges(): string {
  const v = g.__clusterView;
  const lines: string[] = [];
  lines.push("# HELP sv_cluster_nodes_alive Instante vii vazute in ultimele 15s");
  lines.push("# TYPE sv_cluster_nodes_alive gauge");
  lines.push(`sv_cluster_nodes_alive ${v ? v.alive : 0}`);
  lines.push("# HELP sv_cluster_inflight_global Interogari origin in zbor, suma cluster");
  lines.push("# TYPE sv_cluster_inflight_global gauge");
  lines.push(`sv_cluster_inflight_global ${v ? v.globalInflight : 0}`);
  lines.push("# HELP sv_cluster_rps_global Cereri pe secunda, suma cluster (fereastra 10s)");
  lines.push("# TYPE sv_cluster_rps_global gauge");
  lines.push(`sv_cluster_rps_global ${v ? v.globalRps : 0}`);
  lines.push("# HELP sv_cluster_capacity_global Buget origin global (plafon concurenta x instante)");
  lines.push("# TYPE sv_cluster_capacity_global gauge");
  lines.push(`sv_cluster_capacity_global ${v ? v.globalCapacity : 0}`);
  return lines.join("\n") + "\n";
}

/** Reset complet (teste): șterge lease-uri, back-off și cache-ul de vedere. */
export function resetClusterLocalState(): void {
  g.__clusterLeases = new Map();
  g.__clusterPoolEmptyUntil = new Map();
  g.__clusterView = undefined;
  g.__clusterLeaseCount = 0;
}
