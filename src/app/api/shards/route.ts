import { NextRequest, NextResponse } from "next/server";
import { q, qOne } from "@/lib/pg";
import {
  getShards,
  invalidateShardRegistry,
  dropShardPool,
  probeAllShards,
  probeShard,
  shardsStatus,
  countActiveShards,
} from "@/lib/shards";
import { rateLimit, clientIp, tooMany } from "@/lib/rate-limit";

// ============================================================
// FAZA 15 — /api/shards: administrare SHARDING MULTI-COMPUTE Neon
// GET  = stare reală: registry, health, rânduri per shard, capacitate agregată
// POST = operațiuni admin (protejate prin token x-shard-token):
//        add (înregistrează compute Neon adițional cu DSN), update
//        (state/weight), remove, probe (health-check live pe toate)
// ============================================================

const TOKEN = process.env.NEON_SHARD_TOKEN || "sv15-shard-Kq9w2Rm8Tb5Xz1Lp";

function authed(req: NextRequest): boolean {
  return (req.headers.get("x-shard-token") || "") === TOKEN;
}

/** GET /api/shards — stare completă (public, fără secrete: DSN-urile sunt mascați) */
export async function GET(req: NextRequest) {
  const rl = rateLimit(`shards:${clientIp(req)}`, { burst: 30, perMinute: 60 });
  if (!rl.ok) return tooMany(rl);
  try {
    const st = await shardsStatus();
    const active = await countActiveShards();
    return NextResponse.json({
      ok: true,
      active,
      total: st.total,
      aggregateCeiling: st.aggregateCeiling,
      // matematica 30 miliarde: x64 partiții/compute → 75 compute-uri;
      // cu x256 partiții/compute → 19 compute-uri (runbook init-neon-v12.ts)
      computeFor30B: { atX64: Math.ceil(30_000_000_000 / 400_000_000), atX256: Math.ceil(30_000_000_000 / 1_600_000_000) },
      shards: st.shards.map((s) => ({
        ...s,
        dsn: s.dsn ? `${s.dsn.split("@")[0].split("//")[0]}//***@${(s.dsn.split("@")[1] || "").split("?")[0]}` : null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

/** POST /api/shards — operațiuni admin (x-shard-token) */
export async function POST(req: NextRequest) {
  const rl = rateLimit(`shards-post:${clientIp(req)}`, { burst: 10, perMinute: 20 });
  if (!rl.ok) return tooMany(rl);
  if (!authed(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const op = String(body.op || "");

  try {
    // ---------- PROBE: health-check live pe toate shard-urile ----------
    if (op === "probe") {
      const results = await probeAllShards();
      const okCount = results.filter((r) => r.ok).length;
      return NextResponse.json({ ok: true, op, probed: results.length, up: okCount, results });
    }

    // ---------- ADD: înregistrează un compute Neon adițional ----------
    if (op === "add") {
      const name = String(body.name || "").trim();
      const dsn = String(body.dsn || "").trim();
      if (!name || !/^[a-z0-9][a-z0-9-]{1,62}$/i.test(name)) {
        return NextResponse.json({ error: "bad-name", message: "Nume invalid (litere/cifre/linii, 2-63 caractere)." }, { status: 400 });
      }
      if (!dsn.startsWith("postgres")) {
        return NextResponse.json({ error: "bad-dsn", message: "DSN-ul trebuie să fie un connection string postgres://…" }, { status: 400 });
      }
      const exists = await qOne<{ id: number }>(`SELECT id FROM shards WHERE name = $1`, [name]);
      if (exists) return NextResponse.json({ error: "exists", message: `Shard-ul „${name}” există deja.` }, { status: 409 });

      // VALIDARE REALĂ: DSN-ul trebuie să răspundă și să aibă schema `content`
      const { neonConfig, Pool } = await import("@neondatabase/serverless");
      const { default: WebSocket } = await import("ws");
      neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;
      const probe = new Pool({ connectionString: dsn, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 8_000 } as never);
      try {
        const chk = await probe.query(
          `SELECT to_regclass('content') IS NOT NULL AS has_content,
                  (SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'content'::regclass) AS partitions`
        );
        const r = chk.rows[0] as { has_content: boolean; partitions: number };
        if (!r.has_content) {
          return NextResponse.json(
            { error: "no-content", message: "DSN-ul nu conține tabela content — rulează întâi DDL-ul de shard (scripts/init-shard-v15.ts)." },
            { status: 400 }
          );
        }
        if (!r.partitions || r.partitions < 1) {
          return NextResponse.json(
            { error: "no-partitions", message: "Tabela content nu e partiționată — rulează init-shard-v15.ts." },
            { status: 400 }
          );
        }
      } catch (e) {
        return NextResponse.json(
          { error: "dsn-unreachable", message: `Nu mă pot conecta la DSN: ${String((e as { message?: string })?.message || e).slice(0, 160)}` },
          { status: 400 }
        );
      } finally {
        await probe.end().catch(() => {});
      }

      const region = String(body.region || (dsn.match(/\.([a-z0-9-]+)\.aws\.neon\.tech/i)?.[1] || "eu-central-1"));
      const weight = Math.max(1, Math.min(100, Number(body.weight) || 1));
      const maxRows = Math.max(1_000_000, Number(body.maxRows) || 400_000_000);
      const ins = await q<{ id: number }>(
        `INSERT INTO shards (name, kind, dsn, region, weight, state, max_rows)
         VALUES ($1, 'remote', $2, $3, $4, 'active', $5) RETURNING id`,
        [name, dsn, region, weight, maxRows]
      );
      // primul probe (scrie last_ping_ms în registry)
      const shards = await getShards(true);
      const shard = shards.find((s) => s.id === Number(ins[0].id));
      const health = shard ? await probeShard(shard) : { ok: false, pingMs: 0 };
      invalidateShardRegistry();
      return NextResponse.json({ ok: true, op, id: Number(ins[0].id), health });
    }

    // ---------- UPDATE: state / weight / maxRows ----------
    if (op === "update") {
      const id = Number(body.id);
      if (!id) return NextResponse.json({ error: "bad-id" }, { status: 400 });
      const state = body.state ? String(body.state) : null;
      if (state && !["active", "disabled", "draining"].includes(state)) {
        return NextResponse.json({ error: "bad-state" }, { status: 400 });
      }
      const weight = body.weight != null ? Math.max(1, Math.min(100, Number(body.weight))) : null;
      const maxRows = body.maxRows != null ? Math.max(1_000_000, Number(body.maxRows)) : null;
      if (state === "disabled" || state === "draining") dropShardPool(id);
      await q(
        `UPDATE shards SET
           state = COALESCE($2, state),
           weight = COALESCE($3, weight),
           max_rows = COALESCE($4, max_rows),
           updated_at = now()
         WHERE id = $1`,
        [id, state, weight, maxRows]
      );
      invalidateShardRegistry();
      return NextResponse.json({ ok: true, op, id });
    }

    // ---------- REMOVE: scoate shard-ul din registry (datele rămân pe compute) ----------
    if (op === "remove") {
      const id = Number(body.id);
      if (!id) return NextResponse.json({ error: "bad-id" }, { status: 400 });
      const local = await qOne<{ kind: string }>(`SELECT kind FROM shards WHERE id = $1`, [id]);
      if (local?.kind === "local") {
        return NextResponse.json({ error: "local-protected", message: "Shard-ul primar nu poate fi eliminat." }, { status: 400 });
      }
      dropShardPool(id);
      await q(`DELETE FROM shards WHERE id = $1`, [id]); // content_shard_map cascadează
      invalidateShardRegistry();
      return NextResponse.json({ ok: true, op, id });
    }

    return NextResponse.json({ error: "unknown-op", ops: ["probe", "add", "update", "remove"] }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
