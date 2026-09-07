// Verificare rapidă playback_events + views pentru canale TV
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";

neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require",
});

const r = await pool.query(
  `SELECT event, provider, count(*)::int AS n FROM playback_events WHERE provider = 'hls' GROUP BY event, provider`
);
console.log("playback_events HLS:", r.rows);
const v = await pool.query(
  `SELECT title, views FROM content WHERE external_id LIKE 'popnews:%' AND views > 0 LIMIT 5`
);
console.log("canale cu views:", v.rows);
const s = await pool.query(
  `SELECT norm, hits FROM search_stats ORDER BY hits DESC LIMIT 3`
);
console.log("top search:", s.rows);
await pool.end();
