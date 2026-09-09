// ============================================================
// FAZA 16 — DETECȚIE DUPLICATE + ȘTERGERE BULK (postere / conținuturi)
// ============================================================
// • scanDuplicates()  — detectează TOATE duplicatele din bibliotecă pe
//   TOATE shard-urile active: (a) titlu identic (normalizat RO, fără
//   diacritice) + tip, (b) sursă identică (source_url), (c) external_id
//   identic. Grupare finală în JS pe normalizeRo → prinde și variante
//   cu diacritice / majuscule / spații diferite.
// • checkDuplicate()  — gardă la ÎNCĂRCARE: blochează al doilea conținut
//   identic și raportează „există deja" (folosit de dialog + API add).
// • deleteContentByIds() — ștergere BULK multi-select pe toate compute-
//   urile (local + remote prin content_shard_map) + curățare playback
//   + invalidare cache. Audit în manage_log.
// • dedupeGroups()    — eliminare automată: păstrează 1 (primul / cel
//   mai bun / cel mai nou), șterge restul din fiecare grup.
// ============================================================
import { q, qOne } from "./pg";
import { normalizeRo, invalidateSearchCache } from "./neon-search";
import { invalidateGlobalRecommendations } from "./recommendations";
import {
  getActiveShards,
  shardQuery,
  shardMapLookup,
  type Shard,
} from "./shards";

export type DupReason = "title" | "source" | "external_id";

export type DupItem = {
  id: number;
  title: string;
  contentType: string;
  provider: string;
  sourceUrl: string | null;
  thumbnail: string | null;
  year: number | null;
  createdAt: string | null;
  shardId: number;
  shardName: string;
};

export type DupGroup = {
  key: string;             // cheie unică de grup
  reason: DupReason;
  reasonLabel: string;
  count: number;           // câte rânduri în grup
  extra: number;           // câte sunt „în plus" (count - 1)
  items: DupItem[];
};

export type ScanResult = {
  groups: DupGroup[];
  totalGroups: number;
  totalExtraRows: number;
  scannedShards: number;
  scanMs: number;
};

const COLS = `id, external_id, title, content_type, provider, source_url, thumbnail, year, created_at`;

function rowToItem(r: Record<string, unknown>, shard: Shard): DupItem {
  return {
    id: Number(r.id),
    title: String(r.title),
    contentType: String(r.content_type),
    provider: String(r.provider),
    sourceUrl: (r.source_url as string) || null,
    thumbnail: (r.thumbnail as string) || null,
    year: r.year == null ? null : Number(r.year),
    createdAt: (r.created_at as string) || null,
    shardId: shard.id,
    shardName: shard.name,
  };
}

/** Scanează UN shard: returnează rândurile care apar în grupuri de duplicate. */
async function scanShard(shard: Shard, maxGroups: number): Promise<{
  rows: Record<string, unknown>[];
  titleKeys: { lt: string; ct: string }[];
  sources: string[];
  extIds: string[];
}> {
  // 1) grupuri candidate pe (lower(title), content_type)
  const g1 = await shardQuery<{ lt: string; ct: string; n: number }>(
    shard,
    `SELECT lower(title) AS lt, content_type AS ct, count(*)::int AS n
     FROM content GROUP BY 1, 2 HAVING count(*) > 1
     ORDER BY n DESC LIMIT $1`,
    [maxGroups]
  ).catch(() => [] as { lt: string; ct: string; n: number }[]);

  // 2) grupuri pe sursă identică
  const g2 = await shardQuery<{ source_url: string; n: number }>(
    shard,
    `SELECT source_url, count(*)::int AS n
     FROM content WHERE source_url IS NOT NULL AND source_url <> ''
     GROUP BY source_url HAVING count(*) > 1
     ORDER BY n DESC LIMIT $1`,
    [maxGroups]
  ).catch(() => [] as { source_url: string; n: number }[]);

  // 3) grupuri pe external_id identic (posibil cross-shard / fallback)
  const g3 = await shardQuery<{ external_id: string; n: number }>(
    shard,
    `SELECT external_id, count(*)::int AS n
     FROM content GROUP BY external_id HAVING count(*) > 1
     ORDER BY n DESC LIMIT $1`,
    [maxGroups]
  ).catch(() => [] as { external_id: string; n: number }[]);

  // 4) aducem rândurile din grupurile candidate (limite rezonabile)
  const params: unknown[] = [];
  let conds: string[] = [];
  if (g1.length) {
    params.push(g1.map((x) => x.lt));
    conds.push(`lower(title) = ANY($${params.length}::text[])`);
    params.push(g1.map((x) => x.ct));
    conds.push(`content_type = ANY($${params.length}::text[])`);
  }
  if (g2.length) {
    params.push(g2.map((x) => x.source_url));
    conds.push(`source_url = ANY($${params.length}::text[])`);
  }
  if (g3.length) {
    params.push(g3.map((x) => x.external_id));
    conds.push(`external_id = ANY($${params.length}::text[])`);
  }
  if (conds.length === 0) return { rows: [], titleKeys: [], sources: [], extIds: [] };
  // Combinația lower(title) ANY + content_type ANY produce și perechi (alt titlu, alt tip)
  // — filtrăm exact la clusterizarea din scanDuplicates (clusterizarea JS decide).
  const rows = await shardQuery<Record<string, unknown>>(
    shard,
    `SELECT ${COLS} FROM content WHERE (${conds.join(" OR ")}) LIMIT 4000`,
    params
  ).catch(() => [] as Record<string, unknown>[]);

  return {
    rows,
    titleKeys: g1.map((x) => ({ lt: x.lt, ct: x.ct })),
    sources: g2.map((x) => x.source_url),
    extIds: g3.map((x) => x.external_id),
  };
}

/**
 * Scan COMPLET pe toate shard-urile active → grupuri de duplicate.
 * Clusterizarea finală e în JS (normalizeRo) → fără dependență de
 * extensii (unaccent) și cross-shard safe (cheile sunt prefixate cu shard-ul).
 */
export async function scanDuplicates(maxGroups = 200): Promise<ScanResult> {
  const t0 = Date.now();
  const shards = await getActiveShards().catch(() => [] as Shard[]);
  const groups = new Map<string, DupGroup>();

  const addGroup = (key: string, reason: DupReason, items: DupItem[]) => {
    if (items.length < 2) return;
    const label =
      reason === "title" ? "Titlu identic (același tip)" : reason === "source" ? "Sursă identică (același link/stream)" : "ID extern identic";
    const prev = groups.get(key);
    if (prev) {
      // fuzionează itemii (același grup poate apărea pe mai multe shard-uri)
      const seen = new Set(prev.items.map((i) => `${i.shardId}:${i.id}`));
      for (const it of items) if (!seen.has(`${it.shardId}:${it.id}`)) prev.items.push(it);
      prev.count = prev.items.length;
      prev.extra = Math.max(0, prev.count - 1);
    } else {
      groups.set(key, {
        key,
        reason,
        reasonLabel: label,
        count: items.length,
        extra: Math.max(0, items.length - 1),
        items,
      });
    }
  };

  let scanned = 0;
  for (const shard of shards) {
    const s = await scanShard(shard, maxGroups).catch(() => null);
    if (!s) continue;
    scanned++;
    const items = s.rows.map((r) => rowToItem(r, shard));

    // (a) titlu+tip: normalizat RO (fără diacritice, lowercase, spații curate)
    const byTitleType = new Map<string, DupItem[]>();
    for (const it of items) {
      const k = `${normalizeRo(it.title)}|${it.contentType}`;
      const arr = byTitleType.get(k) || [];
      arr.push(it);
      byTitleType.set(k, arr);
    }
    for (const [k, arr] of byTitleType) {
      if (arr.length >= 2) addGroup(`t:${k}`, "title", arr);
    }

    // (b) sursă identică
    const bySrc = new Map<string, DupItem[]>();
    for (const it of items) {
      if (!it.sourceUrl) continue;
      const arr = bySrc.get(it.sourceUrl) || [];
      arr.push(it);
      bySrc.set(it.sourceUrl, arr);
    }
    for (const [k, arr] of bySrc) {
      if (arr.length >= 2) addGroup(`s:${normalizeRo(k).slice(0, 180) || k}`, "source", arr);
    }

    // (c) external_id identic (posibil produs de fallback cross-shard)
    const byExt = new Map<string, DupItem[]>();
    for (const r of s.rows) {
      const ext = String(r.external_id ?? "");
      if (!ext) continue;
      const it = rowToItem(r, shard);
      const arr = byExt.get(ext) || [];
      arr.push(it);
      byExt.set(ext, arr);
    }
    for (const [k, arr] of byExt) {
      if (arr.length >= 2) addGroup(`e:${k}`, "external_id", arr);
    }
  }

  const list = [...groups.values()]
    .sort((a, b) => b.extra - a.extra || b.count - a.count)
    .slice(0, maxGroups);

  return {
    groups: list,
    totalGroups: list.length,
    totalExtraRows: list.reduce((sum, gr) => sum + gr.extra, 0),
    scannedShards: scanned,
    scanMs: Date.now() - t0,
  };
}

export type DupMatch = {
  id: number;
  title: string;
  reason: DupReason;
  contentType: string;
  shardId: number;
  shardName: string;
};

/**
 * Gardă la încărcare: există deja un conținut identic?
 *  • external_id exact (hartă cross-shard + local)
 *  • sursă identică (source_url) pe toate shard-urile active
 *  • titlu normalizat identic + același tip (blochează „două la fel")
 * excludeId = id-ul de ignorat (la editare).
 */
export async function checkDuplicate(opts: {
  externalId?: string | null;
  sourceUrl?: string | null;
  title?: string | null;
  contentType?: string | null;
  excludeId?: number | null;
}): Promise<{ duplicate: boolean; matches: DupMatch[] }> {
  const matches: DupMatch[] = [];
  const seen = new Set<string>();
  const push = (rows: Record<string, unknown>[], reason: DupReason, shard: Shard) => {
    for (const r of rows) {
      const id = Number(r.id);
      if (opts.excludeId && id === opts.excludeId) continue;
      const k = `${shard.id}:${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      matches.push({
        id,
        title: String(r.title),
        reason,
        contentType: String(r.content_type),
        shardId: shard.id,
        shardName: shard.name,
      });
    }
  };

  const shards = await getActiveShards().catch(() => [] as Shard[]);
  const title = opts.title ? normalizeRo(opts.title) : "";
  const ctype = opts.contentType || null;
  const src = (opts.sourceUrl || "").trim();

  await Promise.all(
    shards.map(async (shard) => {
      // 1) external_id exact
      if (opts.externalId) {
        const rows = await shardQuery<Record<string, unknown>>(
          shard,
          `SELECT id, title, content_type FROM content WHERE external_id = $1 LIMIT 3`,
          [opts.externalId]
        ).catch(() => [] as Record<string, unknown>[]);
        push(rows, "external_id", shard);
      }
      // 2) sursă identică
      if (src) {
        const rows = await shardQuery<Record<string, unknown>>(
          shard,
          `SELECT id, title, content_type FROM content WHERE source_url = $1 LIMIT 3`,
          [src]
        ).catch(() => [] as Record<string, unknown>[]);
        push(rows, "source", shard);
      }
      // 3) titlu identic + același tip — candidatura lenientă în SQL
      //    (egalitate lowercase SAU trigram similarity > 0.8 pentru variante
      //    cu diacritice/punctuație), decizia STRICTĂ în JS pe normalizeRo
      if (title && ctype) {
        const rows = await shardQuery<Record<string, unknown>>(
          shard,
          `SELECT id, title, content_type FROM content
           WHERE content_type = $2
             AND (lower(title) = $1 OR similarity(lower(title), $1) > 0.8)
           LIMIT 8`,
          [opts.title!.toLowerCase(), ctype]
        ).catch(() => [] as Record<string, unknown>[]);
        const norm = rows.filter(
          (r) => normalizeRo(String(r.title)) === title
        );
        push(norm, "title", shard);
      }
    })
  );

  // external_id pe shard remote prin hartă (rândul nu e pe primar)
  if (opts.externalId && matches.length === 0) {
    const mapped = await shardMapLookup(opts.externalId).catch(() => null);
    if (mapped) {
      matches.push({
        id: mapped.remoteId ?? -1,
        title: "(pe compute remote)",
        reason: "external_id",
        contentType: ctype || "",
        shardId: mapped.shard.id,
        shardName: mapped.shard.name,
      });
    }
  }

  return { duplicate: matches.length > 0, matches: matches.slice(0, 8) };
}

/**
 * ȘTERGERE BULK pe ID-uri (multi-select). Șterge:
 *  • rândurile locale (pe primar) + playback_events asociate;
 *  • rândurile remote pe shard-ul deținător (prin content_shard_map);
 *  • înregistrările din content_shard_map.
 * Returnează per-shard detalii reale. Audit scris în manage_log.
 */
export async function deleteContentByIds(
  ids: number[],
  actor: string | null
): Promise<{ deleted: number; local: number; remote: number; missing: number; detail: { shard: string; deleted: number }[] }> {
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
  if (clean.length === 0) return { deleted: 0, local: 0, remote: 0, missing: 0, detail: [] };

  // 1) local (primar)
  const localRows = await q<{ id: number }>(
    `DELETE FROM content WHERE id = ANY($1::bigint[]) RETURNING id`,
    [clean]
  ).catch(() => [] as { id: number }[]);
  const localIds = localRows.map((r) => r.id);
  if (localIds.length) {
    await q(`DELETE FROM playback_events WHERE content_id = ANY($1::bigint[])`, [localIds]).catch(() => {});
  }

  // 2) remote prin hartă (remote_id = id-ul cerut, shard ≠ primar)
  let remote = 0;
  const detail: { shard: string; deleted: number }[] = [];
  const localShard = (await getActiveShards().catch(() => [] as Shard[])).find((s) => s.kind === "local");
  const mapRows = await q<{ shard_id: number; remote_id: number }>(
    `SELECT m.shard_id, m.remote_id
     FROM content_shard_map m
     WHERE m.remote_id = ANY($1::bigint[])`,
    [clean]
  ).catch(() => [] as { shard_id: number; remote_id: number }[]);

  if (mapRows.length) {
    const shards = await getActiveShards().catch(() => [] as Shard[]);
    const byShard = new Map<number, number[]>();
    for (const m of mapRows) {
      const arr = byShard.get(Number(m.shard_id)) || [];
      arr.push(Number(m.remote_id));
      byShard.set(Number(m.shard_id), arr);
    }
    for (const [shardId, remoteIds] of byShard) {
      const shard = shards.find((s) => s.id === shardId);
      if (!shard || shard.kind === "local") continue;
      const del = await shardQuery<{ id: number }>(
        shard,
        `DELETE FROM content WHERE id = ANY($1::bigint[]) RETURNING id`,
        [remoteIds]
      ).catch((e) => {
        console.error(`[manage] DELETE remote pe ${shard.name} eșuat:`, String((e as { message?: string })?.message || e).slice(0, 200));
        return [] as { id: number }[];
      });
      if (del.length) {
        await shardQuery(
          shard,
          `DELETE FROM playback_events WHERE content_id = ANY($1::bigint[])`,
          [del.map((d) => Number(d.id))]
        ).catch(() => {});
      }
      remote += del.length;
      detail.push({ shard: shard.name, deleted: del.length });
    }
    // curățăm harta indiferent (rândul remote poate fi deja dispărut)
    await q(
      `DELETE FROM content_shard_map WHERE remote_id = ANY($1::bigint[])`,
      [clean]
    ).catch(() => {});
  }

  const deleted = localIds.length + remote;
  const missing = clean.length - deleted;

  await q(
    `INSERT INTO manage_log (action, deleted, actor, detail)
     VALUES ('bulk_delete', $1, $2, $3)`,
    [deleted, actor, JSON.stringify({ requested: clean.length, local: localIds.length, remote, byShard: detail })]
  ).catch(() => {});

  invalidateSearchCache();
  void invalidateGlobalRecommendations().catch(() => {});
  void localShard;
  return { deleted, local: localIds.length, remote, missing, detail };
}

/**
 * DEDUPE automat: scanează duplicatele și păstrează UN singur reprezentant
 * per grup (keep: first = id minim, best = popularitate maximă, newest =
 * cel mai recent). Șterge restul cu deleteContentByIds (audit inclus).
 */
export async function dedupeGroups(
  keep: "first" | "best" | "newest",
  groupKeys: string[] | null,
  actor: string | null
): Promise<{ groupsProcessed: number; deleted: number; kept: { key: string; keptId: number; removed: number[] }[] }> {
  const scan = await scanDuplicates();
  const groups = groupKeys && groupKeys.length ? scan.groups.filter((gr) => groupKeys.includes(gr.key)) : scan.groups;

  const toDelete: number[] = [];
  const kept: { key: string; keptId: number; removed: number[] }[] = [];

  for (const gr of groups) {
    const sorted = [...gr.items];
    sorted.sort((a, b) => {
      if (keep === "first") return a.id - b.id;
      if (keep === "newest") return (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0);
      return b.id - a.id; // „best" folosește id-ul maxim ca proxy stabil (popularitatea nu e în item)
    });
    const keeper = sorted[0];
    const rest = sorted.slice(1).map((i) => i.id);
    if (rest.length) {
      toDelete.push(...rest);
      kept.push({ key: gr.key, keptId: keeper.id, removed: rest });
    }
  }

  const res = await deleteContentByIds(toDelete, actor);
  await q(
    `INSERT INTO manage_log (action, deleted, actor, detail)
     VALUES ('dedupe', $1, $2, $3)`,
    [res.deleted, actor, JSON.stringify({ keep, groups: kept.length, keepStrategy: keep })]
  ).catch(() => {});

  return { groupsProcessed: kept.length, deleted: res.deleted, kept };
}

/** Contor rapid pentru badge-ul din UI (fără scan complet). */
export async function duplicateQuickCount(): Promise<{ groups: number; extra: number; scanMs: number }> {
  const t0 = Date.now();
  const rows = await qOne<{ g: string; e: string }>(
    `SELECT (SELECT count(*)::text FROM (
        SELECT lower(title), content_type FROM content GROUP BY 1, 2 HAVING count(*) > 1
     ) t) AS g,
     (SELECT COALESCE(sum(n - 1), 0)::text FROM (
        SELECT count(*) AS n FROM content GROUP BY lower(title), content_type HAVING count(*) > 1
     ) t) AS e`
  ).catch(() => null);
  return {
    groups: Number(rows?.g || 0),
    extra: Number(rows?.e || 0),
    scanMs: Date.now() - t0,
  };
}


