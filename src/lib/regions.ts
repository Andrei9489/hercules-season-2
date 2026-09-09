// ============================================================
// FAZA 16 — MULTI-REGION ROUTING (EU / US / APAC) + READ-REPLICA DEDICATĂ
// ============================================================
// Registry-ul de regiuni trăiește ÎN Neon (tabela `regions`) → partajat
// cross-instance. Fiecare regiune = un endpoint Neon:
//   • primary  → primarul acestui proiect (scrieri + citiri, pg.ts)
//   • replica  → endpoint de citire dedicat (read-replica Neon), DSN-ul
//                vine din env (NEON_REPLICA_URL / _US_URL / _APAC_URL).
// O regiune cu DSN setat în env devine automat ACTIVĂ (state calculat la
// citirea registry-ului) — provisionarea unei replici în consola Neon NU
// necesită nicio schimbare de cod.
//
// Rutare citiri: qReadRegion(code) → pool-ul regiunii dacă e activă, altfel
// pool-ul RO din pg.ts (replica-ready; fallback garantat — citirea nu
// eșuează niciodată din cauza rutării). /api/search și /api/channels aleg
// regiunea din headerele geo (cf-ipcountry / x-vercel-ip-country) sau din
// parametrul ?region=.
// ============================================================
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
import { q, qRead } from "./pg";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

export type RegionGroup = "EU" | "US" | "APAC";

export type Region = {
  id: number;
  code: string;
  name: string;
  group: RegionGroup;
  role: "primary" | "replica";
  envVar: string | null;
  state: "active" | "planned" | "disabled";
  dsnSet: boolean;            // DSN-ul rezolvabil din env? (secretul NU pleacă)
  lastPingMs: number | null;
  lastOkAt: string | null;
  lastError: string | null;
};

// env → DSN per cod regiune (codurile din registry)
const REGION_ENV: Record<string, string> = {
  "eu-central-1-r": "NEON_REPLICA_URL",
  "us-east-1": "NEON_REPLICA_US_URL",
  "ap-southeast-1": "NEON_REPLICA_APAC_URL",
};

const REGISTRY_TTL_MS = 30_000;
const globalForRegions = globalThis as unknown as {
  __regionCache?: { at: number; regions: Region[] };
  __regionPools?: Map<string, Pool>;
};
const g = globalForRegions;

export function invalidateRegionRegistry(): void {
  g.__regionCache = undefined;
}

function dsnFor(code: string): string | null {
  const envName = REGION_ENV[code];
  if (!envName) return null; // primarul → pg.ts
  const v = process.env[envName] || "";
  return v.startsWith("postgres") ? v : null;
}

export async function getRegions(force = false): Promise<Region[]> {
  if (!force && g.__regionCache && Date.now() - g.__regionCache.at < REGISTRY_TTL_MS) {
    return g.__regionCache.regions;
  }
  const rows = await qRead<Record<string, unknown>>(
    `SELECT id, code, name, region_group, role, env_var, state,
            last_ping_ms, last_ok_at, last_error
     FROM regions ORDER BY id`
  );
  const regions: Region[] = rows.map((r) => {
    const code = String(r.code);
    const dsn = dsnFor(code);
    const dbState = String(r.state);
    // primarul e ÎNTOTDEAUNA activ; o replică e activă doar cu DSN rezolvabil
    const state: Region["state"] =
      r.role === "primary" ? "active" : dbState === "disabled" ? "disabled" : dsn ? "active" : "planned";
    return {
      id: Number(r.id),
      code,
      name: String(r.name),
      group: (String(r.region_group) || "EU") as RegionGroup,
      role: r.role === "primary" ? "primary" : "replica",
      envVar: (r.env_var as string) || null,
      state,
      dsnSet: Boolean(dsn),
      lastPingMs: r.last_ping_ms == null ? null : Number(r.last_ping_ms),
      lastOkAt: (r.last_ok_at as string) || null,
      lastError: (r.last_error as string) || null,
    };
  });
  g.__regionCache = { at: Date.now(), regions };
  return regions;
}

function poolFor(region: Region): Pool {
  if (!g.__regionPools) g.__regionPools = new Map();
  let p = g.__regionPools.get(region.code);
  if (!p) {
    const dsn = dsnFor(region.code);
    if (!dsn) throw new Error(`regiunea ${region.code} nu are DSN configurat`);
    p = new Pool({
      connectionString: dsn,
      max: 8,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 8_000,
      query_timeout: 10_000,
    } as never);
    p.on("error", () => { /* health probe raportează */ });
    g.__regionPools.set(region.code, p);
  }
  return p;
}

export function dropRegionPool(code: string): void {
  const p = g.__regionPools?.get(code);
  if (p) {
    void p.end().catch(() => {});
    g.__regionPools?.delete(code);
  }
}

/**
 * Citire rutată pe regiune. Ordinea de fallback:
 *   pool-ul regiunii cerute (dacă e activă) → pool RO din pg.ts.
 * Citirea NU eșuează niciodată din cauza rutării — degradăm grațios pe RO.
 */
export async function qReadRegion<T = Record<string, unknown>>(
  regionCode: string | null | undefined,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  if (regionCode) {
    try {
      const regions = await getRegions();
      const r = regions.find((x) => x.code === regionCode);
      if (r && r.state === "active" && r.dsnSet) {
        const t0 = Date.now();
        try {
          const res = (await poolFor(r).query(sql, params as never[])) as { rows: T[] };
          const pingMs = Date.now() - t0;
          if (!r.lastPingMs || Math.abs(r.lastPingMs - pingMs) > 25) {
            await q(
              `UPDATE regions SET last_ping_ms = $2, last_ok_at = now(), last_error = NULL, updated_at = now() WHERE code = $1`,
              [r.code, pingMs]
            ).catch(() => {});
          }
          return res.rows;
        } catch (e) {
          const msg = String((e as { message?: string })?.message || e).slice(0, 200);
          await q(
            `UPDATE regions SET last_error = $2, updated_at = now() WHERE code = $1`,
            [r.code, msg]
          ).catch(() => {});
          // replică picată → fallback transparent pe RO/primar
        }
      }
    } catch {
      /* registry indisponibil → fallback */
    }
  }
  return qRead<T>(sql, params);
}

/** Probe activă: SELECT 1 cu cronometru + update health în registry. */
export async function probeRegion(region: Region): Promise<{ ok: boolean; pingMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    if (region.role === "primary") {
      await qRead(`SELECT 1`);
    } else {
      if (!region.dsnSet) throw new Error("DSN necofigurat (env lipsă)");
      await poolFor(region).query(`SELECT 1`);
    }
    const pingMs = Date.now() - t0;
    await q(
      `UPDATE regions SET last_ping_ms = $2, last_ok_at = now(), last_error = NULL, state = CASE WHEN role = 'primary' THEN 'active' ELSE state END, updated_at = now() WHERE code = $1`,
      [region.code, pingMs]
    ).catch(() => {});
    invalidateRegionRegistry();
    return { ok: true, pingMs };
  } catch (e) {
    const msg = String((e as { message?: string })?.message || e).slice(0, 200);
    await q(
      `UPDATE regions SET last_error = $2, updated_at = now() WHERE code = $1`,
      [region.code, msg]
    ).catch(() => {});
    invalidateRegionRegistry();
    return { ok: false, pingMs: Date.now() - t0, error: msg };
  }
}

export async function probeAllRegions(): Promise<{ code: string; ok: boolean; pingMs: number; error?: string }[]> {
  const regions = await getRegions(true);
  return Promise.all(
    regions.map(async (r) => {
      const res = await probeRegion(r);
      return { code: r.code, ok: res.ok, pingMs: res.pingMs, error: res.error };
    })
  );
}

// ---------- Alegerea regiunii din cerere (geo-routing) ----------

/** țări → regiune (listă reprezentativă; restul lumii = EU implicit). */
const US_COUNTRIES = new Set(["US", "CA", "MX", "BR", "AR", "CL", "CO", "PE"]);
const APAC_COUNTRIES = new Set([
  "CN", "JP", "KR", "IN", "ID", "TH", "VN", "PH", "MY", "SG", "AU", "NZ",
  "TW", "HK", "BD", "PK", "LK", "NP", "KH", "MM", "MN", "KZ", "UZ", "FJ",
]);

/**
 * Regiunea preferată pentru o cerere: header geo (cf-ipcountry /
 * x-vercel-ip-country), parametru ?region= sau implicit EU (primarul).
 */
export function regionFromRequest(
  countryHeader: string | null,
  regionParam: string | null
): string {
  if (regionParam && /^[a-z0-9-]{2,20}$/i.test(regionParam)) return regionParam.toLowerCase();
  const c = (countryHeader || "").toUpperCase();
  if (US_COUNTRIES.has(c)) return "us-east-1";
  if (APAC_COUNTRIES.has(c)) return "ap-southeast-1";
  return "eu-central-1";
}

/** Starea completă (pentru /api/regions și /api/status). */
export async function regionsStatus(): Promise<{
  regions: Region[];
  active: number;
  total: number;
  configuredNote: string;
}> {
  const regions = await getRegions(true);
  return {
    regions,
    active: regions.filter((r) => r.state === "active").length,
    total: regions.length,
    configuredNote: regions.filter((r) => r.state === "active" && r.role === "replica").length
      ? "replici active: " + regions.filter((r) => r.state === "active" && r.role === "replica").map((r) => r.code).join(", ")
      : "nicio replică activă — setează NEON_REPLICA_URL (EU dedicată) / NEON_REPLICA_US_URL / NEON_REPLICA_APAC_URL după provisionarea în consola Neon; rutarea e deja LIVE, zero schimbări de cod",
  };
}
