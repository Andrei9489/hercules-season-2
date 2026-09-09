// FAZA 18 — TEST INTEGRAL cu codul REAL din src/lib:
//  • 18a: probe regiuni prin runMaintenance (probe_regions + cleanup_recommend_cache)
//  • 18b: FIX bug recomandări personalizate (coloane camelCase + userId real)
//  • 18b: recomandări CROSS-SHARD (conținut pe compute remote devine vizibil)
//  • 18b: semnale profunde (History+Watchlist+Favorite) + co-watch + excluderi
//  • 18b: L2 cache în Neon (ai_recommend_cache) + invalidare + jurnal
// Curățenie completă la final (inclusiv ștergere cross-shard reală). Idempotent.
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

import { insertContent, invalidateSearchCache } from "../src/lib/neon-search";
import { routeBatch, getActiveShards, invalidateShardRegistry, shardQuery, shardMapLookup } from "../src/lib/shards";
import { deleteContentByIds } from "../src/lib/duplicates";
import { q } from "../src/lib/pg";
import { getUserIdByEmail } from "../src/lib/auth";
import {
  getUserSignals,
  coWatchIds,
  resolveIdsAcrossShards,
  recommendForUserV2,
  recommendGlobalV2,
  recommendBySeedV2,
  invalidateRecommendations,
  keywordsFromTitles,
} from "../src/lib/recommendations";
import { runMaintenance } from "../src/lib/maintain-core";

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const TAG = `f18t${Date.now().toString(36)}`;
let okCount = 0;
let failCount = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    okCount++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const pool = new Pool({ connectionString: url, max: 3 });

async function userIdFor(email: string): Promise<string> {
  const r = await pool.query(`SELECT "id" FROM "User" WHERE email = $1`, [email]);
  if (r.rows.length) return r.rows[0].id;
  return (await getUserIdByEmail(email)) as string;
}

async function addHistory(uid: string, mediaId: string, mediaType: string, title: string) {
  await pool.query(
    `INSERT INTO "History" ("id","userId","mediaId","mediaType","title","source","progress","duration","updatedAt")
     VALUES (gen_random_uuid()::text,$1,$2,$3,$4,'neon',0.4,100,now())
     ON CONFLICT ("userId","mediaId","mediaType") DO UPDATE SET "updatedAt" = now()`,
    [uid, mediaId, mediaType, title]
  );
}

async function main() {
  console.log("FAZA 18 — TEST INTEGRAL\n");

  // ---------- SETUP: activăm shard_b pentru cross-shard ----------
  const active0 = await getActiveShards();
  const shardB = active0.find((s) => s.kind === "remote");
  const shardBWasActive = !!shardB;
  if (!shardB) {
    await pool.query(`UPDATE shards SET state='active' WHERE name='shard-b-eu-central-1'`);
    invalidateShardRegistry();
  }
  const active = await getActiveShards(true);
  const remote = active.find((s) => s.kind === "remote");
  ok("shard remote activ pentru test", !!remote, `${remote?.name || "lipsă"} (${active.length} active)`);

  // ---------- 18a: mentenanță cu probe_regions + cache recomandări ----------
  console.log("\n1. MAINTENANȚĂ FAZA 18 (probe_regions + cleanup_recommend_cache)");
  const rep = await runMaintenance("all");
  const regions = (rep as Record<string, unknown>).regions as { probed?: number; ok?: number } | undefined;
  ok("probe_regions în raport", !!regions && typeof regions.probed === "number", `probed=${regions?.probed}, ok=${regions?.ok}`);
  ok("cleanup_recommend_cache prezent", "recommendCacheDeleted" in rep, `deleted=${(rep as Record<string, unknown>).recommendCacheDeleted}`);

  // ---------- 18b: keywords helper ----------
  console.log("\n2. EXTRAGERE CUVINTE-CHEIE");
  const kws = keywordsFromTitles(["Metal Ritualuri și Legături", "Metal War of Ideas"]);
  ok("cuvinte frecvente primează", kws.includes("metal"), kws.join(","));
  ok("stopwords filtrate", !kws.some((k) => ["și", "de", "of", "the"].includes(k)), kws.join(","));

  // ---------- SETUP: conținut distribuit determinist ----------
  console.log("\n3. SETUP CONȚINUT (distribuție deterministă pe shard-uri)");
  const all = await getActiveShards(true);
  const remoteShard = all.find((s) => s.kind === "remote")!;
  const localShard = all.find((s) => s.kind === "local")!;
  function pickIdsFor(target: number, n: number): string[] {
    const out: string[] = [];
    let i = 0;
    while (out.length < n && i < 500) {
      const cand = `${TAG}:${target}:${i}`;
      const map = routeBatch([cand], all);
      if ((map.get(target) || []).includes(cand)) out.push(cand);
      i++;
    }
    return out;
  }
  const remoteIds = pickIdsFor(remoteShard.id, 3);
  const localIds = pickIdsFor(localShard.id, 3);
  ok("id-uri determinist pe ambele compute", remoteIds.length === 3 && localIds.length === 3, `remote=${remoteIds.length}, local=${localIds.length}`);

  const created: { id: number; title: string; externalId: string }[] = [];
  const mk = (ext: string, title: string, type: string) =>
    insertContent({
      externalId: ext,
      title,
      description: `Test ${TAG} — descriere pentru motorul de recomandări v2`,
      contentType: type,
      provider: "test-f18",
      sourceType: "embed",
      sourceUrl: `https://example.com/${ext}`,
      year: 2024,
      tags: ["test"],
    });
  // titluri FĂRĂ tokenul TAG (să nu polueze keyword-urile); curățenia merge pe ID-uri
  for (const [i, ext] of remoteIds.entries()) {
    const r = await mk(ext, `Metal Ritualuri Unice R${i}`, "movie");
    if (r) created.push({ id: Number(r.id), title: r.title, externalId: ext });
  }
  for (const [i, ext] of localIds.entries()) {
    const r = await mk(ext, `Metal Legături Profunde L${i}`, "movie");
    if (r) created.push({ id: Number(r.id), title: r.title, externalId: ext });
  }
  ok("conținut inserat prin rutare reală", created.length === 6, `${created.length} rânduri`);

  // ordinea în `created`: [0..2] = REMOTE, [3..5] = LOCAL
  const remoteCreated = created.filter((c) => remoteIds.includes(c.externalId));
  const mapOk = await shardMapLookup(remoteIds[0]);
  ok("hartă de rutare scrisă pentru remote", !!mapOk, mapOk ? `${mapOk.shard.name} → remote_id=${mapOk.remoteId}` : "lipsă");

  // ---------- 18b: FIX coloane + semnale ----------
  console.log("\n4. SEMNALE UTILIZATOR (fix camelCase + userId real)");
  const userA = await userIdFor(`${TAG}-a@test.ro`);
  const userB = await userIdFor(`${TAG}-b@test.ro`);
  ok("utilizatori creați/rezolvați (User.id, nu email)", !!userA && !!userB && userA !== userB, userA.slice(0, 8));

  // A: seeds = created[0], created[1] (REMOTE); watchlist = created[3], favorite = created[4] (locale)
  // A NU a văzut: created[2] (remote) și created[5] (local)
  await addHistory(userA, String(created[0].id), "movie", created[0].title);
  await addHistory(userA, String(created[1].id), "movie", created[1].title);
  await pool.query(
    `INSERT INTO "Watchlist" ("id","userId","mediaId","mediaType","title","source") VALUES (gen_random_uuid()::text,$1,$2,'movie',$3,'neon')
     ON CONFLICT ("userId","mediaId","mediaType") DO NOTHING`,
    [userA, String(created[3].id), created[3].title]
  );
  await pool.query(
    `INSERT INTO "Favorite" ("id","userId","mediaId","mediaType","title","source") VALUES (gen_random_uuid()::text,$1,$2,'movie',$3,'neon')
     ON CONFLICT ("userId","mediaId","mediaType") DO NOTHING`,
    [userA, String(created[4].id), created[4].title]
  );
  // B: suprapunere cu A pe created[0] + urmărește created[2] (REMOTE, nevăzut de A — țintă co-watch cross-shard)
  await addHistory(userB, String(created[0].id), "movie", created[0].title);
  await addHistory(userB, String(created[2].id), "movie", created[2].title);

  const sig = await getUserSignals(userA);
  ok("seeds din History numeric (fix coloane)", sig.seedIds.length === 2, `seeds=${sig.seedIds.length}`);
  ok("interacted include watchlist+favorite", sig.interactedIds.length === 4, `interacted=${sig.interactedIds.length}`);
  ok("afinitate tip detectată", sig.types.includes("movie"), sig.types.join(","));
  ok("cuvinte-cheie din titluri", sig.keywords.includes("metal"), sig.keywords.join(","));

  // ---------- 18b: co-watch ----------
  console.log("\n5. CO-WATCH (filtru colaborativ real)");
  const cw = await coWatchIds(userA, 40);
  ok("co-watch găsește media NEVĂZUT de user, consumat de peer", cw.some((x) => x.id === Number(created[2].id) && x.n >= 1), `${cw.length} candidați`);

  // ---------- 18b: rezolvare cross-shard (fostul gap) ----------
  console.log("\n6. REZOLVARE ID-URI CROSS-SHARD");
  const allIds = created.map((c) => c.id);
  const resolved = await resolveIdsAcrossShards(allIds);
  const remoteFound = resolved.some((r) => remoteCreated.some((c) => c.id === Number(r.id)));
  ok("id-uri remote găsite prin scatter", remoteFound, `${resolved.length}/${allIds.length} rezolvate`);

  // ---------- 18b: recomandări personalizate ----------
  console.log("\n7. RECOMANDĂRI PERSONALIZATE v2");
  invalidateSearchCache("rec:");
  await invalidateRecommendations(userA);
  const rec = await recommendForUserV2(userA, 6);
  ok("mod personal", rec.mode === "personal", rec.mode);
  ok("itemi returning", rec.items.length > 0, `${rec.items.length} itemi`);
  ok("excludere totală a interacted", !rec.items.some((it) => sig.interactedIds.includes(it.id)));
  ok("conținut CROSS-SHARD în recomandări", rec.items.some((it) => remoteCreated.some((c) => c.id === it.id)), "itemi de pe compute remote vizibili");
  ok("co-watch în recomandări cu motiv", rec.items.some((it) => it.id === Number(created[2].id) && it.reason.includes("gusturi asemănătoare")), rec.items.map((it) => `${it.id}:${it.reason.slice(0, 30)}`).join(" | "));
  ok("motive populate", rec.items.every((it) => it.reason.length > 3));

  // ---------- 18b: L2 cache + invalidare ----------
  console.log("\n8. L2 CACHE ÎN NEON (ai_recommend_cache)");
  const rec2 = await recommendForUserV2(userA, 6);
  ok("a doua apelare servită din cache", rec2.computedAt === rec.computedAt, `computedAt identic`);
  const cacheRow = await pool.query(`SELECT cache_key FROM ai_recommend_cache WHERE cache_key = $1`, [`rec:user:${userA}:6`]);
  ok("rând cache în Neon", cacheRow.rows.length === 1);
  await invalidateRecommendations(userA);
  const cacheAfter = await pool.query(`SELECT cache_key FROM ai_recommend_cache WHERE cache_key = $1`, [`rec:user:${userA}:6`]);
  ok("invalidare șterge cache-ul", cacheAfter.rows.length === 0);
  const jlog = await pool.query(`SELECT count(*)::int AS n FROM recommend_log WHERE user_key = $1`, [userA]);
  ok("jurnal recommend_log scris", jlog.rows[0].n >= 1, `${jlog.rows[0].n} rulări`);

  // ---------- 18b: global + seed ----------
  console.log("\n9. GLOBAL + SEED");
  await pool.query(`DELETE FROM ai_recommend_cache WHERE cache_key LIKE 'rec:global:%'`);
  const g = await recommendGlobalV2(6);
  ok("global din scatter (mode=global)", g.mode === "global" && g.items.length > 0, `${g.items.length} itemi`);
  const gRemote = g.items.some((it) => remoteCreated.some((c) => c.id === it.id));
  ok("global include compute remote", gRemote);
  const seed = await recommendBySeedV2(created[0].id, 6);
  ok("seed similar funcțional", seed.items.length > 0, `mode=${seed.mode}`);

  // ---------- CURĂȚENIE ----------
  console.log("\n10. CURĂȚENIE");
  const del = await deleteContentByIds(allIds, "test-f18");
  ok("ștergere cross-shard reală", del.deleted === allIds.length, `local=${del.local}, remote=${del.remote}, missing=${del.missing}`);
  await pool.query(`DELETE FROM "History" WHERE "userId" IN ($1,$2)`, [userA, userB]);
  await pool.query(`DELETE FROM "Watchlist" WHERE "userId" IN ($1,$2)`, [userA, userB]);
  await pool.query(`DELETE FROM "Favorite" WHERE "userId" IN ($1,$2)`, [userA, userB]);
  await pool.query(`DELETE FROM "User" WHERE "id" IN ($1,$2)`, [userA, userB]);
  await pool.query(`DELETE FROM ai_recommend_cache WHERE cache_key LIKE 'rec:%'`);
  await pool.query(`DELETE FROM recommend_log WHERE user_key IN ($1,$2) OR cache_key LIKE 'rec:global:%' OR cache_key LIKE 'rec:seed:%'`, [userA, userB]);
  await pool.query(`DELETE FROM content_shard_map WHERE external_id LIKE '${TAG}%'`);
  if (!shardBWasActive) {
    await pool.query(`UPDATE shards SET state='disabled' WHERE name='shard-b-eu-central-1'`);
    invalidateShardRegistry();
  }
  invalidateSearchCache();
  const leftContent = await pool.query(`SELECT count(*)::int AS n FROM content WHERE provider='test-f18'`);
  ok("platformă pristine după test", leftContent.rows[0].n === 0, `content rămase=${leftContent.rows[0].n}`);

  console.log(`\n=== REZULTAT: ${okCount} OK / ${failCount} EȘEC ===`);
  await pool.end();
  if (failCount > 0) process.exit(1);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("EȘEC FATAL:", e);
  // curățenie de urgență
  try {
    await pool.query(`DELETE FROM content WHERE provider='test-f18'`);
    await pool.query(`DELETE FROM content_shard_map WHERE external_id LIKE '${TAG}%'`);
    await pool.query(`DELETE FROM "History" WHERE "userId" IN (SELECT "id" FROM "User" WHERE email LIKE '%${TAG}%')`);
    await pool.query(`DELETE FROM "User" WHERE email LIKE '%${TAG}%'`);
    await pool.query(`DELETE FROM ai_recommend_cache WHERE cache_key LIKE 'rec:%'`);
    await pool.query(`UPDATE shards SET state='disabled' WHERE name='shard-b-eu-central-1'`);
    console.log("curățenie de urgență rulată");
  } catch {}
  process.exit(1);
});
