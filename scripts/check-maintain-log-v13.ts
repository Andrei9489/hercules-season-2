/**
 * Faza 13 — verificare jurnal maintain_log în Neon (cron intern)
 */
import { qRead } from "../src/lib/pg.ts";

const rows = await qRead(
  `SELECT id, at, trigger, ok, duration_ms, left(report::text, 120) AS report
   FROM maintain_log ORDER BY id DESC LIMIT 5`
);
console.log("maintain_log (ultimele 5 rulări):");
for (const r of rows) {
  console.log(` #${r.id} ${r.at} trigger=${r.trigger} ok=${r.ok} ${r.duration_ms}ms`);
  console.log(`   ${r.report}`);
}
process.exit(0);
