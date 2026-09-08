// FAZA 14 — test unitar /api/sync: aplicare, idempotency, clientRef→serverId
// Rulează DIRECT pe Neon (fără server) pentru validare logică SQL.
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

const url =
  (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
    ? process.env.NEON_DATABASE_URL
    : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: url, max: 3 });

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const TEST_USER = "test-sync-user-v14";
const seenId = (opId: string) => pool.query(`SELECT "opId" FROM sync_seen WHERE "userId"=$1 AND "opId"=$2`, [TEST_USER, opId]);

async function main() {
  console.log("— Curățenie pre-test —");
  await pool.query(`DELETE FROM sync_seen WHERE "userId"=$1`, [TEST_USER]);
  await pool.query(`DELETE FROM sync_log WHERE "userId"=$1`, [TEST_USER]);
  await pool.query(`DELETE FROM "Watchlist" WHERE "userId"=$1`, [TEST_USER]);
  await pool.query(`DELETE FROM collections WHERE user_id=$1`, [TEST_USER]);
  // utilizator de test (FK Watchlist_userId → User.id)
  await pool.query(
    `INSERT INTO "User" ("id","name","email") VALUES ($1,'Test Sync V14','test-sync-v14@streamverse.ro')
     ON CONFLICT ("id") DO NOTHING`,
    [TEST_USER]
  );

  console.log("— T1: watchlist.add aplicat —");
  const op1 = "op-t1-" + crypto.randomUUID().slice(0, 8);
  const media = { mediaId: "m-t1", mediaType: "movie", title: "Film Test Sync", poster: null, backdrop: null, year: "2026", rating: 7.5, source: "sync" };
  {
    const r = await pool.query(
      `INSERT INTO "Watchlist" ("id","userId","mediaId","mediaType","title","poster","backdrop","year","rating","source")
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT ("userId","mediaId","mediaType") DO UPDATE SET "title"=$4`,
      [TEST_USER, media.mediaId, media.mediaType, media.title, media.poster, media.backdrop, media.year, media.rating, media.source]
    );
    check("INSERT watchlist OK", r.rowCount === 1);
    await pool.query(`INSERT INTO sync_seen ("userId","opId","type") VALUES ($1,$2,'user.watchlist.add')`, [TEST_USER, op1]);
  }

  console.log("— T2: idempotență — același opId = deja văzut —");
  {
    const s = await seenId(op1);
    check("opId găsit în sync_seen", !!s.rows[0]);
  }

  console.log("— T3: collections.create → serverId + mapare —");
  const clientRef = crypto.randomUUID();
  let serverId = "";
  {
    const created = await pool.query(
      `INSERT INTO collections (id, user_id, name, description, is_public, items_count)
       VALUES (gen_random_uuid()::text, $1, $2, '', false, 0)
       ON CONFLICT (user_id, lower(name)) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [TEST_USER, "Colecție Sync Test"]
    );
    serverId = created.rows[0].id;
    await pool.query(
      `INSERT INTO sync_seen ("userId","opId","type","result") VALUES ($1,$2,'collections.create',$3)`,
      [TEST_USER, clientRef, JSON.stringify({ serverId })]
    );
    check("serverId creat", !!serverId);
  }

  console.log("— T4: collections.add prin clientRef (rezolvare mapare) —");
  {
    // simulăm exact resolveCollectionId din route: direct? nu. mapat? da.
    const mapped = await pool.query(
      `SELECT result FROM sync_seen WHERE "userId"=$1 AND "opId"=$2 AND type='collections.create'`,
      [TEST_USER, clientRef]
    );
    const resolved = (mapped.rows[0]?.result as { serverId?: string } | null)?.serverId ?? null;
    check("clientRef → serverId", resolved === serverId);
  }

  console.log("— T5: sync_log jurnal —");
  {
    await pool.query(
      `INSERT INTO sync_log ("id","userId","device","pushed","skipped","failed","opsByType","durationMs","ok")
       VALUES (gen_random_uuid()::text,$1,'test',2,1,0,$2,123,true)`,
      [TEST_USER, JSON.stringify({ "user.watchlist.add": 1, "collections.create": 1 })]
    );
    const log = await pool.query(`SELECT pushed, skipped, device FROM sync_log WHERE "userId"=$1`, [TEST_USER]);
    check("sync_log are rând", log.rows.length === 1, `pushed=${log.rows[0]?.pushed}, device=${log.rows[0]?.device}`);
  }

  console.log("— T6: integritate — coada /api/sync GET ar vedea datele —");
  {
    const counts = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM "Watchlist" WHERE "userId"=$1) AS wl,
        (SELECT count(*)::int FROM collections WHERE user_id=$1) AS cols,
        (SELECT count(*)::int FROM sync_seen WHERE "userId"=$1) AS seen`,
      [TEST_USER]
    );
    check("watchlist=1, collections=1, seen=2", counts.rows[0].wl === 1 && counts.rows[0].cols === 1 && counts.rows[0].seen === 2,
      JSON.stringify(counts.rows[0]));
  }

  console.log("— Curățenie post-test —");
  await pool.query(`DELETE FROM sync_seen WHERE "userId"=$1`, [TEST_USER]);
  await pool.query(`DELETE FROM sync_log WHERE "userId"=$1`, [TEST_USER]);
  await pool.query(`DELETE FROM "Watchlist" WHERE "userId"=$1`, [TEST_USER]);
  await pool.query(`DELETE FROM collections WHERE user_id=$1`, [TEST_USER]);
  await pool.query(`DELETE FROM "User" WHERE "id"=$1`, [TEST_USER]);
  const left = await pool.query(`SELECT count(*)::int AS n FROM sync_seen WHERE "userId"=$1`, [TEST_USER]);
  check("cleanup complet", left.rows[0].n === 0);

  console.log(`\nREZULTAT: ${pass} OK / ${fail} EȘUATE`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error("EȘEC:", e.message); process.exitCode = 1; return pool.end(); });
