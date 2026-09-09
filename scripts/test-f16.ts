// FAZA 16 — TEST INTEGRAL cu codul REAL din src/lib:
//  • multi-region: probe, qReadRegion (activ + fallback), geo-routing
//  • duplicate: gardă la încărcare (titlu normalizat/sursă/external_id),
//    scan pe shard-uri, dedupe automat
//  • bulk delete: local + CROSS-SHARD (rând pe compute remote prin hartă)
// Curățenie completă la final. Idempotent.
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

import { insertContent, invalidateSearchCache } from "../src/lib/neon-search";
import { regionFromRequest, probeAllRegions, qReadRegion } from "../src/lib/regions";
import {
  scanDuplicates,
  checkDuplicate,
  deleteContentByIds,
  dedupeGroups,
} from "../src/lib/duplicates";
import {
  getShards,
  getActiveShards,
  shardQuery,
  shardMapUpsert,
  invalidateShardRegistry,
  type Shard,
} from "../src/lib/shards";
import { q } from "../src/lib/pg";

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const TAG = `f16test:${Date.now().toString(36)}`;
let okCount = 0;
let failCount = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    okCount++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failCount++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log(`\n=== FAZA 16 — TEST INTEGRAL (tag: ${TAG}) ===\n`);

  // ---------- 1) MULTI-REGION ----------
  console.log("1) MULTI-REGION (EU/US/APAC)");
  const regions = await probeAllRegions();
  const primary = regions.find((r) => r.code === "eu-central-1");
  ok("probe primar EU", Boolean(primary?.ok), `${primary?.pingMs}ms`);
  ok("replici planned (nu active) — DSN-uri env lipsă", regions.filter((r) => r.state === "planned" || !r.state).length >= 3 || regions.filter((r) => r.code !== "eu-central-1" && !r.ok).length >= 3);

  const geo1 = regionFromRequest("US", null);
  const geo2 = regionFromRequest("JP", null);
  const geo3 = regionFromRequest("RO", null);
  const geo4 = regionFromRequest(null, "us-east-1");
  ok("geo-routing US→us-east-1", geo1 === "us-east-1", geo1);
  ok("geo-routing JP→ap-southeast-1", geo2 === "ap-southeast-1", geo2);
  ok("geo-routing RO→eu-central-1", geo3 === "eu-central-1", geo3);
  ok("parametru explicit ?region= câștigă", geo4 === "us-east-1", geo4);

  // citire prin rutarea regională (fallback transparent pe RO — regiune neactivă)
  const t0 = Date.now();
  const rows = await qReadRegion("us-east-1", `SELECT 1 AS one`);
  ok("qReadRegion fallback (regiune neactivă → RO, fără eroare)", rows[0]?.one === 1, `${Date.now() - t0}ms`);
  const rows2 = await qReadRegion("eu-central-1", `SELECT count(*)::int AS n FROM shards`);
  ok("qReadRegion pe regiunea primară", (rows2[0]?.n ?? 0) >= 1, `${rows2[0]?.n} shard-uri`);

  // ---------- 2) DUPLICATE — gardă la încărcare ----------
  console.log("\n2) DUPLICATE — detecție + gardă");
  const title = `Film Test ${TAG}`;
  const ins1 = await insertContent({
    externalId: `${TAG}:a`, title, description: "duplicat test", contentType: "movie",
    provider: "_f16", sourceType: "url", sourceUrl: `https://example.com/${TAG}.mp4`,
    meta: {}, tags: [],
  });
  ok("insert #1 reușit", Boolean(ins1));

  // același titlu normalizat (variantă cu MAJUSCULE — normalizeRo le egalizează)
  const ins2 = await insertContent({
    externalId: `${TAG}:b`, title: `TEMP ${TAG}`, description: "", contentType: "movie",
    provider: "_f16", sourceType: "url", sourceUrl: `https://example.com/${TAG}-alt.mp4`,
    meta: {}, tags: [],
  });
  void ins2;
  await q(`UPDATE content SET title = $2 WHERE external_id = $1`, [`${TAG}:b`, `FILM TEST ${TAG.toUpperCase()}`]);

  // gardă: același external_id
  const chkExt = await checkDuplicate({ externalId: `${TAG}:a` });
  ok("gardă external_id identic → DUPLICAT", chkExt.duplicate && chkExt.matches.some((m) => m.reason === "external_id"));

  // gardă: aceeași sursă
  const chkSrc = await checkDuplicate({ sourceUrl: `https://example.com/${TAG}.mp4` });
  ok("gardă sursă identică → DUPLICAT", chkSrc.duplicate && chkSrc.matches.some((m) => m.reason === "source"));

  // gardă: titlu normalizat identic + același tip („FILM  TEST" vs „Film Test")
  const chkTitle = await checkDuplicate({ title, contentType: "movie" });
  ok("gardă titlu identic (normalizat RO, diacritice/majuscule ignorate) → DUPLICAT", chkTitle.duplicate && chkTitle.matches.some((m) => m.reason === "title"), `${chkTitle.matches.length} potriviri`);

  // titlu DIFERIT + sursă DIFERITĂ → NU e duplicat
  const chkNone = await checkDuplicate({ title: `Titlu Total Alt ${TAG}`, contentType: "movie", sourceUrl: `https://alt.example/${TAG}.mp4` });
  ok("conținut nou (titlu+sursă diferite) → NU e duplicat", !chkNone.duplicate);

  // ---------- 3) SCAN + DEDUPE ----------
  console.log("\n3) SCAN + DEDUPE AUTOMAT");
  const scan = await scanDuplicates();
  const grp = scan.groups.find((g) => g.key.includes(normalizeLocal(title)) && g.reason === "title");
  ok("scan găsește grupul de titluri identice", Boolean(grp), grp ? `${grp.count} exemplare, shard ${scan.scannedShards}, ${scan.scanMs}ms` : "");
  const dedupe = await dedupeGroups("first", grp ? [grp.key] : null, "test-f16");
  ok("dedupe păstrează 1, șterge restul", dedupe.deleted === (grp ? grp.count - 1 : 0) && dedupe.groupsProcessed === 1, `deleted=${dedupe.deleted}`);

  const afterDedupe = await checkDuplicate({ title, contentType: "movie" });
  ok("după dedupe mai există EXACT 1 exemplar", afterDedupe.matches.length === 1, `${afterDedupe.matches.length} rămase`);

  // ---------- 4) BULK DELETE cross-shard ----------
  console.log("\n4) BULK DELETE (local + remote prin content_shard_map)");
  // activăm shard_b pentru test (a fost lăsat disabled după Faza 15)
  const shards = await getShards(true);
  const remote = shards.find((s) => s.kind === "remote");
  let remoteWasDisabled = false;
  let remoteShard: Shard | null = null;
  if (remote) {
    remoteWasDisabled = remote.state !== "active";
    if (remoteWasDisabled) {
      await q(`UPDATE shards SET state = 'active' WHERE id = $1`, [remote.id]);
      invalidateShardRegistry();
    }
    remoteShard = (await getActiveShards()).find((s) => s.id === remote!.id) || null;
  }

  let remoteId: number | null = null;
  if (remoteShard?.dsn) {
    // inserăm DIRECT pe compute-ul remote + înregistrăm în hartă (ca la rutarea reală)
    const r = await shardQuery<{ id: number }>(
      remoteShard,
      `INSERT INTO content (external_id, title, description, content_type, provider, source_type, search_text, meta, tags)
       VALUES ($1, $2, '', 'video', '_f16', 'url', $2, '{}', '{}') RETURNING id`,
      [`${TAG}:remote`, `Remote ${TAG}`]
    );
    // ATENȚIE: bigint returnat de driver vine ca string — convertim explicit
    remoteId = r[0]?.id != null ? Number(r[0].id) : null;
    if (remoteId) await shardMapUpsert(`${TAG}:remote`, remoteShard.id, remoteId);
    ok("rând remote creat pe compute-ul 2 + hartă actualizată", Boolean(remoteId), `remote_id=${remoteId} pe ${remoteShard.name}`);
  } else {
    console.log("  ℹ️ shard remote indisponibil — testul cross-shard sare (calea locală rămâne verificată)");
  }

  // creăm și 2 rânduri locale de șters în masă
  const b1 = await insertContent({ externalId: `${TAG}:del1`, title: `Bulk 1 ${TAG}`, description: "", contentType: "video", provider: "_f16", sourceType: "url", sourceUrl: null, meta: {}, tags: [] });
  const b2 = await insertContent({ externalId: `${TAG}:del2`, title: `Bulk 2 ${TAG}`, description: "", contentType: "video", provider: "_f16", sourceType: "url", sourceUrl: null, meta: {}, tags: [] });
  console.log(`  ℹ️ diag: b1=${b1?.id ?? "NULL"} b2=${b2?.id ?? "NULL"} remote=${remoteId ?? "NULL"}`);
  const ids = [b1?.id, b2?.id, remoteId].filter((x): x is number => typeof x === "number");
  ok("inserturile pentru bulk (locale + remote) au ID-uri", ids.length === 3, `ids=[${ids.join(", ")}]+${remoteId}`);
  const bulk = await deleteContentByIds(ids, "test-f16");
  ok(`bulk delete ${ids.length} ID-uri (inclusiv remote)`, bulk.deleted === ids.length, `local=${bulk.local} remote=${bulk.remote} missing=${bulk.missing} ${JSON.stringify(bulk.detail)}`);

  // harta trebuie curățată pentru remote_id
  if (remoteId) {
    const mapLeft = await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_shard_map WHERE remote_id = $1`, [remoteId]);
    ok("content_shard_map curățat după ștergerea remote", Number(mapLeft[0]?.n || 0) === 0);
  }

  // restaurăm starea shard-ului remote
  if (remote && remoteWasDisabled) {
    await q(`UPDATE shards SET state = 'disabled' WHERE id = $1`, [remote.id]);
    invalidateShardRegistry();
  }

  // ---------- 5) audit + curățenie ----------
  console.log("\n5) AUDIT + CURĂȚENIE");
  const logRows = await q<{ n: string }>(`SELECT count(*)::text AS n FROM manage_log WHERE actor = 'test-f16'`);
  ok("manage_log conține auditul operațiunilor", Number(logRows[0]?.n || 0) >= 2, `${logRows[0]?.n} intrări`);

  await q(`DELETE FROM content WHERE external_id LIKE '${TAG}%' OR provider = '_f16'`);
  await q(`DELETE FROM manage_log WHERE actor = 'test-f16'`);
  invalidateSearchCache();

  const left = await q<{ n: string }>(`SELECT count(*)::text AS n FROM content WHERE provider = '_f16'`);
  ok("curățenie completă (0 rânduri test rămase)", Number(left[0]?.n || 0) === 0, `${left[0]?.n} rămase`);

  console.log(`\n=== REZULTAT: ${okCount} OK • ${failCount} EȘEC ===\n`);
  if (failCount > 0) process.exitCode = 1;
}

function normalizeLocal(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

main()
  .catch((e) => {
    console.error("EȘEC TEST F16:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // curățenie de urgență dacă testul a căzut înainte de finally-ul intern
    try {
      await q(`DELETE FROM content WHERE external_id LIKE '${TAG}%' OR provider = '_f16'`);
      await q(`DELETE FROM manage_log WHERE actor = 'test-f16'`);
    } catch { /* pool poate fi deja închis */ }
    process.exit(process.exitCode || 0);
  });
