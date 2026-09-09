// E2E Faza 18 — conținut temporar pentru rail-ul de recomandări + curățenie la final
import { neonConfig, Pool } from "@neondatabase/serverless";
import WebSocket from "ws";
neonConfig.webSocketConstructor = WebSocket as unknown as typeof globalThis.WebSocket;

import { insertContent } from "../src/lib/neon-search";
import { deleteContentByIds } from "../src/lib/duplicates";
import { q } from "../src/lib/pg";

const url = (process.env.NEON_DATABASE_URL || "").startsWith("postgres")
  ? process.env.NEON_DATABASE_URL
  : "postgresql://neondb_owner:npg_k8zGXZEKr5xV@ep-sparkling-leaf-b2wkkjbz-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const cmd = process.argv[2] || "add";
const pool = new Pool({ connectionString: url, max: 2 });

async function main() {
  if (cmd === "add") {
    const items = [
      { ext: "f18e2e:m1", title: "Povestiri de la Marea Neagră", type: "movie" },
      { ext: "f18e2e:m2", title: "Delta Dunării — Documentar", type: "documentary" },
      { ext: "f18e2e:m3", title: "Radio Ambient România", type: "radio" },
      { ext: "f18e2e:m4", title: "Seria Carpați Episodul 1", type: "series" },
    ];
    const ids: number[] = [];
    for (const it of items) {
      const r = await insertContent({
        externalId: it.ext,
        title: it.title,
        description: "Conținut E2E Faza 18 pentru rail-ul de recomandări.",
        contentType: it.type,
        provider: "test-f18e2e",
        sourceType: "embed",
        sourceUrl: `https://example.com/${it.ext}`,
        year: 2024,
        popularity: 70,
      });
      if (r) ids.push(Number(r.id));
    }
    console.log("ADD:", ids.join(","));
  } else if (cmd === "clean") {
    const rows = await pool.query(`SELECT id FROM content WHERE provider='test-f18e2e'`);
    const ids = rows.rows.map((r) => Number(r.id));
    if (ids.length) {
      const del = await deleteContentByIds(ids, "test-f18e2e");
      console.log("CLEAN:", JSON.stringify(del.detail), "deleted=", del.deleted);
    } else console.log("CLEAN: 0");
    await q(`DELETE FROM ai_recommend_cache WHERE cache_key LIKE 'rec:%'`);
    await q(`DELETE FROM recommend_log WHERE cache_key LIKE 'rec:%'`);
  }
  await pool.end();
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
