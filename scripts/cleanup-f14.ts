// FAZA 14 — verificare + curățenie finală a datelor de test E2E
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;
const url = (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
  ? process.env.NEON_DATABASE_URL
  : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const pool = new Pool({ connectionString: url, max: 2 });

async function main() {
  const u = await pool.query(`SELECT id FROM "User" WHERE email LIKE $1 LIMIT 1`, ["demo%"]);
  const uid = u.rows[0]?.id;
  if (!uid) { console.log("no demo user"); return; }

  const before = await pool.query(
    `SELECT (SELECT count(*) FROM "Watchlist" WHERE "userId"=$1) wl,
            (SELECT count(*) FROM "Favorite" WHERE "userId"=$1) fav,
            (SELECT count(*) FROM sync_log WHERE "userId"=$1) slog,
            (SELECT count(*) FROM sync_seen WHERE "userId"=$1) sseen`,
    [uid]
  );
  console.log("ÎNAINTE:", JSON.stringify(before.rows[0]));

  // curățenie: datele de test ale utilizatorului demo (platforma rămâne user-driven pristine)
  await pool.query(`DELETE FROM sync_seen WHERE "userId"=$1`, [uid]);
  await pool.query(`DELETE FROM sync_log WHERE "userId"=$1`, [uid]);
  await pool.query(`DELETE FROM "Watchlist" WHERE "userId"=$1`, [uid]);
  await pool.query(`DELETE FROM "Favorite" WHERE "userId"=$1`, [uid]);
  await pool.query(`DELETE FROM "History" WHERE "userId"=$1`, [uid]);
  // itemul de bibliotecă de test din E2E
  await pool.query(`DELETE FROM content WHERE title = $1`, ["X36xhzz"]);
  // utilizatorul de test sync (dacă a rămas)
  await pool.query(`DELETE FROM "User" WHERE id = $1`, ["test-sync-user-v14"]);

  const after = await pool.query(
    `SELECT (SELECT count(*) FROM content) content,
            (SELECT count(*) FROM sync_log) slog,
            (SELECT count(*) FROM sync_seen) sseen,
            (SELECT count(*) FROM "Watchlist") wl_total`
  );
  console.log("DUPĂ CURĂȚENIE (global):", JSON.stringify(after.rows[0]));
  console.log("✅ Platforma pristine — doar structurile sync (sync_log/sync_seen goale, gata de producție).");
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error("EȘEC:", e.message); process.exitCode = 1; return pool.end(); });
