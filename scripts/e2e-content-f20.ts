// E2E Faza 20 — conținut temporar pentru fluxul social în browser + curățenie
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
    const r = await insertContent({
      externalId: "f20e2e:m1",
      title: "E2E Social Test Film",
      description: "Conținut E2E Faza 20 pentru fluxul social (comentarii/like/follow/feed).",
      contentType: "movie",
      provider: "test-f20e2e",
      sourceType: "embed",
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      year: 2025,
      popularity: 85,
    });
    console.log("ADD:", r?.id ?? "NULL");
    process.exit(0);
  }
  if (cmd === "clean") {
    const rows = await q<{ id: number }>(
      `SELECT id FROM content WHERE external_id = 'f20e2e:m1'`
    );
    if (rows.length) {
      await deleteContentByIds(rows.map((r) => r.id));
      console.log("CLEAN: deleted", rows.map((r) => r.id).join(","));
    } else {
      console.log("CLEAN: nothing");
    }
    await pool.end();
    process.exit(0);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
