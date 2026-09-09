// FAZA 20 — TEST INTEGRAL cu codul REAL din src/lib + HTTP real pe dev:
//  • 20b: DDL social live (5 tabele) + sanitizare comentarii
//  • 20b: comentarii reale (add/list/delete cu autorizare), reacții like
//  • 20b: L2 distribuit în social_cache + stare viewer per cerere (fără scurgeri)
//  • 20b: invalidare L2 la scrieri + follow/unfollow + feed global/following
//  • HTTP real: 401 fără sesiune pe scrieri, 200 pe citiri, faza20 în /api/status
// Curățenie completă la final. Idempotent.
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

import {
  addComment, listComments, deleteComment, toggleCommentLike,
  toggleFollow, followStatus, recordActivity, activityFeed,
  socialStats, sanitizeBody, invalidateCommentsCache,
} from "../src/lib/social";
import { q } from "../src/lib/pg";

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const TAG = `f20t${Date.now().toString(36)}`;
const MEDIA_ID = `${TAG}media`;
const BASE = "http://localhost:3000";
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

async function makeUser(name: string): Promise<string> {
  const id = `${TAG}-${name.toLowerCase()}`;
  await pool.query(
    `INSERT INTO "User" (id, name, email) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name`,
    [id, name, `${id}@test.local`]
  );
  return id;
}

async function main() {
  console.log(`\n=== FAZA 20 — test integral (tag ${TAG}) ===\n`);

  // ── 1. DDL live ─────────────────────────────────────────────
  console.log("1) DDL social live în Neon");
  const tables = await pool.query(
    `SELECT to_regclass('social_comment') c, to_regclass('social_reaction') r,
            to_regclass('social_follow') f, to_regclass('social_activity') a,
            to_regclass('social_cache') s`
  );
  const t = tables.rows[0];
  ok("cele 5 tabele social există", Boolean(t.c && t.r && t.f && t.a && t.s),
    `${t.c} • ${t.r} • ${t.f} • ${t.a} • ${t.s}`);

  // ── 2. Sanitizare ───────────────────────────────────────────
  console.log("2) Sanitizare comentarii");
  const dirty = "  Salut\u0000\u001F lume\u007F!  ";
  const clean = sanitizeBody(dirty);
  ok("strip caractere de control + trim", clean === "Salut lume!", `"${clean}"`);
  ok("limită dură 1000 chars", sanitizeBody("x".repeat(1500)).length === 1000);

  // ── utilizatori de test ────────────────────────────────────
  const userA = await makeUser("Ana Test");
  const userB = await makeUser("Bogdan Test");
  ok("utilizatori de test creați", Boolean(userA && userB), `${userA} + ${userB}`);

  // ── 3. Comentarii reale (lib) ──────────────────────────────
  console.log("3) Comentarii — add/list/delete cu autorizare");
  const c1 = await addComment(userA, MEDIA_ID, "movie", "Primul comentariu REAL în Neon! 🎬");
  ok("addComment returnează id + body", Boolean(c1.id) && c1.body.includes("Primul comentariu"));
  const c1row = await pool.query(
    `SELECT body, "userId" FROM social_comment WHERE id = $1`, [c1.id]
  );
  ok("rând în Neon cu autor corect", c1row.rows.length === 1 && c1row.rows[0].userId === userA);

  const listAnon = await listComments(MEDIA_ID, "movie", null);
  ok("listă publică: total=1, fără stare viewer",
    listAnon.total === 1 && listAnon.items[0].viewerLiked === false && listAnon.items[0].likes === 0);

  // L2 cache populat
  const cacheRows = await pool.query(
    `SELECT key FROM social_cache WHERE key LIKE $1`, [`soc:cm:${MEDIA_ID}:%`]
  );
  ok("L2 distribuit: cheie soc:cm:* în Neon", cacheRows.rows.length >= 1, `${cacheRows.rows.length} chei`);
  const listAgain = await listComments(MEDIA_ID, "movie", null);
  ok("a 2-a listare servită din L2 (conținut identic)", listAgain.total === 1 && listAgain.items[0].id === c1.id);

  // ── 4. Reacții like + stare viewer per cerere ──────────────
  console.log("4) Reacții — like cu stare viewer rezolvată per cerere");
  const l1 = await toggleCommentLike(userB, c1.id);
  ok("B dă like → active", l1.active === true);
  const listB = await listComments(MEDIA_ID, "movie", userB);
  ok("viewer B: viewerLiked=true, likes=1", listB.items[0].viewerLiked === true && listB.items[0].likes === 1);
  const listA = await listComments(MEDIA_ID, "movie", userA);
  ok("viewer A: viewerLiked=false DAR likes=1 (fără scurgere de stare, L2 partajat)",
    listA.items[0].viewerLiked === false && listA.items[0].likes === 1);
  const l2 = await toggleCommentLike(userB, c1.id);
  ok("B retrage like → inactive", l2.active === false);
  const listB2 = await listComments(MEDIA_ID, "movie", userB);
  ok("după retragere likes=0", listB2.items[0].likes === 0);

  // ── 5. Invalidare L2 la scrieri ────────────────────────────
  console.log("5) Invalidare L2 la scrieri");
  await listComments(MEDIA_ID, "movie", null); // repopulează cache
  const before = await pool.query(`SELECT count(*)::int n FROM social_cache WHERE key LIKE $1`, [`soc:cm:${MEDIA_ID}:%`]);
  await addComment(userA, MEDIA_ID, "movie", "Al doilea comentariu — invalidare!");
  const after = await pool.query(`SELECT count(*)::int n FROM social_cache WHERE key LIKE $1`, [`soc:cm:${MEDIA_ID}:%`]);
  ok("cache invalidat la addComment", before.rows[0].n > 0 && after.rows[0].n === 0,
    `${before.rows[0].n} → ${after.rows[0].n}`);

  // ── 6. Delete cu autorizare ────────────────────────────────
  console.log("6) Delete cu autorizare");
  const c2 = (await pool.query(
    `SELECT id FROM social_comment WHERE "mediaId"=$1 ORDER BY "createdAt" DESC LIMIT 1`, [MEDIA_ID]
  )).rows[0].id;
  const delOther = await deleteComment(userB, c2);
  ok("B nu poate șterge comentariul lui A", delOther === false);
  const delOwn = await deleteComment(userA, c2);
  ok("A își șterge propriul comentariu", delOwn === true);
  const remain = await pool.query(`SELECT count(*)::int n FROM social_comment WHERE "mediaId"=$1`, [MEDIA_ID]);
  ok("rânduri rămase = 1", remain.rows[0].n === 1);

  // ── 7. Follow ──────────────────────────────────────────────
  console.log("7) Urmăritori");
  const self = await toggleFollow(userA, userA).then(() => false).catch(() => true);
  ok("self-follow respins", self === true);
  const f1 = await toggleFollow(userB, userA);
  ok("B urmărește A", f1.active === true);
  const dup = await toggleFollow(userB, userA);
  ok("re-follow idempotent (toggle off)", dup.active === false);
  await toggleFollow(userB, userA); // re-on pentru feed
  const st = await followStatus(userB, userA);
  ok("status: A are 1 follower, B urmărește 1", st.followers === 1 && st.viewerFollows === true,
    `followers=${st.followers} viewerFollows=${st.viewerFollows}`);

  // ── 8. Feed activitate ─────────────────────────────────────
  console.log("8) Feed activitate global / following");
  await recordActivity(userA, "watch", { mediaId: MEDIA_ID, mediaType: "movie", title: "Test Film", poster: null });
  await recordActivity(userA, "review", { mediaId: MEDIA_ID, mediaType: "movie", title: "Test Film", rating: 4 });
  const feedGlobal = await activityFeed(null, 20);
  ok("feed global conține activitatea A", feedGlobal.scope === "global" &&
    feedGlobal.items.some((i) => i.userId === userA && i.kind === "watch"),
    `${feedGlobal.items.length} itemi`);
  const feedB = await activityFeed(userB, 20);
  ok("feed following pentru B include activitatea lui A (B urmărește A)",
    feedB.scope === "following" && feedB.items.some((i) => i.userId === userA && i.kind === "review"),
    `${feedB.items.length} itemi, scope=${feedB.scope}`);

  // ── 9. socialStats ─────────────────────────────────────────
  console.log("9) Statistici globale (pentru /api/status)");
  const stats = await socialStats();
  ok("socialStats returnează contori reale",
    typeof stats.comments === "number" && stats.comments >= 1 && typeof stats.follows === "number",
    `comments=${stats.comments} reactions=${stats.reactions} follows=${stats.follows} activity24h=${stats.activity24h}`);

  // ── 10. HTTP real (dev server) ─────────────────────────────
  console.log("10) HTTP real — citiri publice 200, scrieri fără sesiune 401");
  const rGet = await fetch(`${BASE}/api/social/comments?mediaId=${MEDIA_ID}&mediaType=movie`);
  const dGet = await rGet.json() as { items: unknown[]; total: number; authed: boolean };
  ok("GET comments → 200", rGet.status === 200 && Array.isArray(dGet.items), `total=${dGet.total}`);

  const rPost = await fetch(`${BASE}/api/social/comments`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: MEDIA_ID, mediaType: "movie", body: "x" }),
  });
  ok("POST comments fără sesiune → 401", rPost.status === 401);

  const rRx = await fetch(`${BASE}/api/social/reactions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commentId: c1.id }),
  });
  ok("POST reactions fără sesiune → 401", rRx.status === 401);

  const rFl = await fetch(`${BASE}/api/social/follow`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: userA }),
  });
  ok("POST follow fără sesiune → 401", rFl.status === 401);

  const rFeed = await fetch(`${BASE}/api/social/feed?limit=5`);
  const dFeed = await rFeed.json() as { scope: string; items: unknown[] };
  ok("GET feed → 200 global", rFeed.status === 200 && dFeed.scope === "global");

  const rStatus = await fetch(`${BASE}/api/status`);
  const dStatus = await rStatus.json() as { faza20?: { live?: { comments?: number } } };
  ok("/api/status conține faza20.live (statistici sociale reale)",
    Boolean(dStatus.faza20?.live && typeof dStatus.faza20.live.comments === "number"),
    JSON.stringify(dStatus.faza20?.live || {}));

  // ── 11. Curățenie ──────────────────────────────────────────
  console.log("\n11) Curățenie completă");
  await invalidateCommentsCache();
  await pool.query(`DELETE FROM social_comment WHERE "mediaId" = $1 OR "userId" LIKE $2`, [MEDIA_ID, `${TAG}%`]);
  await pool.query(`DELETE FROM social_reaction WHERE "userId" LIKE $1 OR "targetId" = $2`, [`${TAG}%`, c1.id]);
  await pool.query(`DELETE FROM social_follow WHERE "followerId" LIKE $1 OR "followeeId" LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM social_activity WHERE "userId" LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM social_cache WHERE key LIKE 'soc:cm:%' OR key LIKE 'soc:feed:%'`);
  await pool.query(`DELETE FROM "User" WHERE id LIKE $1 OR email LIKE $2`, [`${TAG}%`, `%${TAG}%`]);
  const left = await pool.query(
    `SELECT (SELECT count(*)::int FROM social_comment WHERE "userId" LIKE $1) c,
            (SELECT count(*)::int FROM "User" WHERE id LIKE $1) u`,
    [`${TAG}%`]
  );
  ok("zero rămășițe test", left.rows[0].c === 0 && left.rows[0].u === 0,
    `comments=${left.rows[0].c} users=${left.rows[0].u}`);

  console.log(`\n=== REZULTAT: ${okCount} OK / ${failCount} EȘEC ===\n`);
  process.exitCode = failCount > 0 ? 1 : 0;
  await pool.end();
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
