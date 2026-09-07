// ============================================================
// Benchmark REAL — motor de căutare StreamVerse (Faza 3)
// Măsoară pe /api/search (mode=library) și /api/channels:
//   throughput (req/s), latență P50/P90/P95/P99, eroare, cache-hit.
// Fiecare cerere folosește un x-forwarded-for unic (utilizatori
// distincți) → parcurge și calea de rate-limiting.
// Rulează: bun scripts/bench-search.ts
// ============================================================

const BASE = "http://localhost:3000";

type Sample = { ms: number; status: number; cached: boolean };

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runPhase(
  name: string,
  path: (i: number) => string,
  total: number,
  concurrency: number
): Promise<Sample[]> {
  const samples: Sample[] = [];
  let done = 0;
  let idx = 0;
  const t0 = Date.now();

  async function worker(): Promise<void> {
    while (idx < total) {
      const my = idx++;
      const url = `${BASE}${path(my)}`;
      const t = Date.now();
      let status = 0;
      let cached = false;
      try {
        const res = await fetch(url, {
          headers: {
            "x-forwarded-for": `10.${(my % 250) + 1}.${((my * 7) % 250) + 1}.${((my * 13) % 250) + 1}`,
            connection: "keep-alive",
          },
          cache: "no-store",
        });
        status = res.status;
        if (res.ok) {
          try {
            const j = (await res.json()) as { cached?: boolean };
            cached = Boolean(j.cached);
          } catch { /* nu contează */ }
        }
      } catch {
        status = 0;
      }
      samples.push({ ms: Date.now() - t, status, cached });
      done++;
      if (done % 100 === 0) {
        const el = (Date.now() - t0) / 1000;
        console.log(`    ${name}: ${done}/${total} • ${(done / el).toFixed(0)} req/s`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const el = (Date.now() - t0) / 1000;
  return samples;
}

function summarize(name: string, samples: Sample[]): { name: string; rps: number; p50: number; p90: number; p95: number; p99: number; errPct: number; cacheHitPct: number; n: number } {
  const ok = samples.filter((s) => s.status === 200);
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const el = samples.length; // folosit doar pentru context
  const rps = el > 0 ? 0 : 0; // calculat extern
  void rps; void ok;
  return {
    name,
    rps: 0, // completat de apelant
    p50: pct(lat, 50),
    p90: pct(lat, 90),
    p95: pct(lat, 95),
    p99: pct(lat, 99),
    errPct: el ? ((samples.length - ok.length) / samples.length) * 100 : 0,
    cacheHitPct: samples.length ? (samples.filter((s) => s.cached).length / samples.length) * 100 : 0,
    n: samples.length,
  };
}

async function main() {
  console.log("Benchmark motor de căutare StreamVerse — Neon");
  console.log("=".repeat(58));

  // ---- listă de query-uri REALE din biblioteca Neon ----
  const titles: string[] = [
    "al jazeera", "bbc news", "digi 24", "cnn", "sky news", "france 24",
    "dwell", "oppenheimer", "big buck", "dune", "breaking bad", "anime",
    "nhk", "trt", "euronews", "disney", "pixar", "marvel", "ghibli",
    "documentar", "telenovela", "sport", "muzică", "gaming", "cctv",
    "rtve", "bfm", "cnews", "newsmax", "zee", "ndtv", "arirang",
    "sintel", "tears of steel", "apple bipbop", "hls", "vimeo",
    "realitatea", "antena", "pro tv", "observator", "k-drama", "bollywood",
  ];
  const channelQs = ["news", "digi", "tv", "al jazeera", "sky", "cnn", "news24", "bbc"];

  const pick = (i: number) => titles[i % titles.length];
  const sp = (q: string) => `q=${encodeURIComponent(q)}&mode=library&limit=24`;

  // ---- Warmup (compilare rute + cache cald) ----
  console.log("\n[0] Warmup (30 cereri secvențiale)…");
  await runPhase("warmup", (i) => `/api/search?${sp(pick(i))}`, 30, 1);

  const results: { name: string; rps: number; p50: number; p90: number; p95: number; p99: number; errPct: number; cacheHitPct: number; n: number }[] = [];

  async function bench(name: string, pathFn: (i: number) => string, total: number, conc: number): Promise<void> {
    console.log(`\n[${name}] ${total} cereri • concurență ${conc}…`);
    const t0 = Date.now();
    const s = await runPhase(name, pathFn, total, conc);
    const el = (Date.now() - t0) / 1000;
    const row = summarize(name, s);
    row.rps = s.length / el;
    results.push(row);
    console.log(
      `  → ${row.rps.toFixed(0)} req/s • P50 ${row.p50}ms • P90 ${row.p90}ms • P95 ${row.p95}ms • P99 ${row.p99}ms • erori ${row.errPct.toFixed(1)}% • cache-hit ${row.cacheHitPct.toFixed(0)}%`
    );
  }

  await bench("A: căutare 50x", (i) => `/api/search?${sp(pick(i))}`, 500, 50);
  await bench("B: căutare 150x", (i) => `/api/search?${sp(pick(i))}`, 900, 150);
  await bench("C: canale TV 50x", (i) => `/api/channels?q=${encodeURIComponent(channelQs[i % channelQs.length])}&limit=48`, 200, 50);
  await bench("D: suggest 150x", (i) => `/api/search?mode=suggest&q=${encodeURIComponent(pick(i).slice(0, 4))}`, 300, 150);

  console.log("\n" + "=".repeat(58));
  console.log("REZUMAT (necesar interpretării: 1 instanță dev pe sandbox):");
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(18)} ${r.rps.toFixed(0).padStart(5)} req/s • P50 ${String(r.p50).padStart(5)}ms • P95 ${String(r.p95).padStart(5)}ms • P99 ${String(r.p99).padStart(5)}ms • err ${r.errPct.toFixed(1)}% • cache ${r.cacheHitPct.toFixed(0)}%`
    );
  }

  // estimare onestă pentru producție (cluster multi-instanță + CDN edge):
  const peak = results.reduce((mx, r) => Math.max(mx, r.rps), 0);
  console.log(`\nPeak măsurat local: ${peak.toFixed(0)} req/s pe 1 instanță sandbox.`);

  await Bun.write(
    "/home/z/my-project/scripts/bench-result.json",
    JSON.stringify({ at: new Date().toISOString(), results, peakLocalRps: peak }, null, 2)
  );
  console.log("Salvat: scripts/bench-result.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
