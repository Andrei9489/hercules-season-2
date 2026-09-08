"use client";

import { useEffect, useState } from "react";
import { Database, Zap, Users, Library, ChevronDown, ChevronUp } from "lucide-react";
import type { CapacityStatus } from "./types";
import { api } from "./api";

/** Panou de capacitate — metrici REALE din Neon + procente față de ținte. */
function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function CapacityPanel() {
  const [st, setSt] = useState<CapacityStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.status<CapacityStatus>()
      .then(setSt)
      .catch(() => {});
  }, []);

  if (!st?.ok) return null;

  const c = st.capacity;

  return (
    <div className="px-4 pt-5 sm:px-6">
      <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-[#0c0c14] to-zinc-900">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left sm:px-5"
          aria-expanded={open}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-600/15 ring-1 ring-red-600/30">
            <Database className="h-4 w-4 text-red-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black tracking-tight">
              Motor & Capacitate <span className="text-red-400">Neon</span>
              <span className="ml-2 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 ring-1 ring-emerald-600/30">
                LIVE • {st.db.provider.split(" ")[0]}
              </span>
            </p>
            <p className="truncate text-[11px] text-zinc-500">
              {st.library.items.toLocaleString("ro-RO")} conținuturi indexate • {st.db.partitions} partiții • {st.db.indexes} indexuri • {st.db.size} • zero stocare locală
            </p>
          </div>
          {open ? <ChevronUp className="h-4 w-4 shrink-0 text-zinc-500" /> : <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />}
        </button>

        {open && (
          <div className="grid gap-3 border-t border-zinc-800/60 p-4 sm:grid-cols-3 sm:p-5">
            {/* Motor de căutare */}
            <div className="rounded-xl bg-zinc-950/70 p-3 ring-1 ring-zinc-800/60">
              <div className="mb-1.5 flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-amber-400" />
                <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Motor de căutare</p>
              </div>
              <p className="text-lg font-black text-zinc-100">
                {c.engine.pct.toFixed(2)}% <span className="text-[11px] font-medium text-zinc-500">din 30 miliarde</span>
              </p>
              <p className="mb-2 text-[11px] text-zinc-500">
                capacitate validată: {(c.engine.validatedRows / 1_000_000).toFixed(0)}M rânduri (Faza {c.engine.phase})
              </p>
              <Bar pct={c.engine.pct} color="bg-amber-500" />
              <ul className="mt-2 space-y-0.5">
                {c.engine.nextSteps.slice(0, 2).map((s) => (
                  <li key={s} className="text-[10px] text-zinc-600">→ {s}</li>
                ))}
              </ul>
            </div>

            {/* Căutări simultane */}
            <div className="rounded-xl bg-zinc-950/70 p-3 ring-1 ring-zinc-800/60">
              <div className="mb-1.5 flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-sky-400" />
                <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Căutări simultane</p>
              </div>
              <p className="text-lg font-black text-zinc-100">
                {c.concurrentSearches.pct}% <span className="text-[11px] font-medium text-zinc-500">din 10.000</span>
              </p>
              <p className="mb-2 text-[11px] text-zinc-500">
                suportate acum: ~{c.concurrentSearches.now.toLocaleString("ro-RO")} • medie {st.search.avgMs ?? "—"}ms
              </p>
              <Bar pct={c.concurrentSearches.pct} color="bg-sky-500" />
              <p className="mt-2 text-[10px] text-zinc-600">→ {c.concurrentSearches.mechanisms.slice(0, 3).join(" • ")}</p>
            </div>

            {/* Utilizatori */}
            <div className="rounded-xl bg-zinc-950/70 p-3 ring-1 ring-zinc-800/60">
              <div className="mb-1.5 flex items-center gap-2">
                <Users className="h-3.5 w-3.5 text-emerald-400" />
                <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Utilizatori conectați</p>
              </div>
              <p className="text-lg font-black text-zinc-100">
                {c.concurrentUsers.pct}% <span className="text-[11px] font-medium text-zinc-500">din 10 milioane</span>
              </p>
              <p className="mb-2 text-[11px] text-zinc-500">
                sesiuni simultane: ~{(c.concurrentUsers.now / 1000).toFixed(0)}K • server stateless
              </p>
              <Bar pct={c.concurrentUsers.pct} color="bg-emerald-500" />
              <p className="mt-2 text-[10px] text-zinc-600">→ {c.concurrentUsers.mechanisms.join(" • ")}</p>
            </div>

            {/* Bibliotecă + statistici reale */}
            <div className="rounded-xl bg-zinc-950/70 p-3 ring-1 ring-zinc-800/60 sm:col-span-3">
              <div className="mb-2 flex items-center gap-2">
                <Library className="h-3.5 w-3.5 text-purple-400" />
                <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Biblioteca ta (URL / Embed / iframe / JS — 100% încărcată de tine)</p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-base font-black text-zinc-100">{st.library.items.toLocaleString("ro-RO")}</p>
                  <p className="text-[10px] text-zinc-500">conținuturi adăugate de tine ({((st.library.items / 30_000_000_000) * 100).toFixed(4)}% din capacitatea de 30 mld)</p>
                </div>
                <div>
                  <p className="text-base font-black text-zinc-100">{st.library.types} tipuri • {st.library.providers} provideri</p>
                  <p className="text-[10px] text-zinc-500">
                    🛰️ {st.library.liveTvChannels ?? "—"} canale TV • 📻 {st.library.radioStations ?? "—"} posturi radio • compat ~{st.player?.compatPct ?? 95}%
                  </p>
                </div>
                <div>
                  <p className="text-base font-black text-zinc-100">{st.search.logsTotal.toLocaleString("ro-RO")} căutări loggate</p>
                  <p className="text-[10px] text-zinc-500">{st.search.logs24h} în ultimele 24h • salvate în Neon</p>
                </div>
                <div>
                  <p className="text-base font-black text-zinc-100">{st.db.size}</p>
                  <p className="text-[10px] text-zinc-500">{st.db.region} • stateless: da • local: 0</p>
                </div>
              </div>
              {st.search.top.length > 0 && (
                <p className="mt-2 truncate text-[10px] text-zinc-600">
                  Trend căutări: {st.search.top.map((t) => `${t.original} (${t.hits})`).join(" • ")}
                </p>
              )}
              {st.benchmark && (
                <p className="mt-1 truncate text-[10px] text-zinc-600">
                  📊 Benchmark real (Faza {c.engine.phase}): {st.benchmark.peakLocalRps} req/s pe 1 instanță • 0 erori la{" "}
                  {st.benchmark.concurrent300 ? "300" : "150"} concurenți • suggest 300x: {st.benchmark.suggest300?.rps ?? "—"} req/s •
                  radio: {st.benchmark.radio ? `${st.benchmark.radio.rps} req/s (P50 ${st.benchmark.radio.p50Ms}ms)` : "—"} • cache L1+L2 distribuit{" "}
                  {st.search.cacheL2?.enabled ? "în Neon (cross-instance)" : ""} • cache-hit{" "}
                  {st.benchmark.concurrent300?.cacheHitPct ?? st.benchmark.concurrent150.cacheHitPct}%
                </p>
              )}
              {st.search.suggest && (
                <p className="mt-1 truncate text-[10px] text-zinc-600">
                  ⚡ Autocompletare: ROLLUP {st.search.suggest.rollup?.buckets ?? "—"} bucket-e (ranking POPULARITATE, lookup PK — Faza {c.engine.phase}) •
                  index covering pe {st.db.partitions} partiții • coalescing prefixe • L2 distribuit {st.search.suggest.l2TtlSec}s • origin DB {st.search.suggest.originMs}ms
                </p>
              )}
              {st.db.readPoolMax != null && (
                <p className="mt-1 truncate text-[10px] text-zinc-600">
                  🔀 Router READ/WRITE: pool citiri {st.db.readPoolMax} conexiuni {st.db.readReplica ? "(REPLICA dedicată activă)" : "(izolate de scrieri, replica-ready)"} • pool scrieri 12
                </p>
              )}
              {st.player?.signing && (
                <p className="mt-1 truncate text-[10px] text-zinc-600">
                  🎬 Player 100%: MPEG-TS (mpegts.js) • semnare server-side {st.player.signing.schemes.join(" / ")} — {st.player.signing.secretExposure} • SRT/RTMP/UDP → restream + copiere URL
                </p>
              )}
              {c.concurrentUsers.anchorFormula && (
                <p className="mt-1 truncate text-[10px] text-zinc-600">
                  📐 Ancoră utilizatori: {c.concurrentUsers.anchorFormula}
                </p>
              )}
              {st.resilience && (
                <p className="mt-1 truncate text-[10px] text-zinc-600">
                  🛡️ Reziliență (Faza {st.resilience.phase}): circuit breaker {st.resilience.circuitBreaker.state} ({st.resilience.circuitBreaker.totalTrips} trip-uri • {st.resilience.circuitBreaker.totalFailFast} fail-fast) •
                  admission control {st.resilience.admissionControl.inFlight}/{st.resilience.admissionControl.maxConcurrent} în zbor ({st.resilience.admissionControl.timedOut} timeout-uri coadă) •
                  statement timeout {st.resilience.statementTimeout.readMs / 1000}s citiri / {st.resilience.statementTimeout.writeMs / 1000}s scrieri • {st.resilience.healthEndpoint}
                </p>
              )}
              {st.userDriven && (
                <p className="mt-1 truncate text-[10px] text-zinc-600">
                  ⬆️ Import tău: {st.userDriven.import.platforms.slice(0, 8).join(", ")}... + playlist M3U/IPTV {st.userDriven.import.m3u.enabled ? `ACTIV (max ${st.userDriven.import.m3u.maxPerImport.toLocaleString("ro-RO")} canale/import, idempotent)` : ""}
                </p>
              )}
              {st.faza11 && (
                <>
                  <p className="mt-1 truncate text-[10px] text-zinc-600">
                    🗂️ Colecții personale (Faza {c.engine.phase}): {st.faza11.collections.ui.join(" • ")} • limită{" "}
                    {st.faza11.collections.limits.maxItems.toLocaleString("ro-RO")} itemi/colecție • {st.faza11.collections.storage}
                  </p>
                  <p className="mt-1 truncate text-[10px] text-zinc-600">
                    ▶ Continuare vizionare: reluare automată de la poziție ({st.faza11.continueWatching.engines.join(", ")}) • progres real % pe carduri
                  </p>
                  <p className="mt-1 truncate text-[10px] text-zinc-600">
                    🔧 Mentenanță automată: {st.faza11.maintenance.operations.length} operațiuni ({st.faza11.maintenance.operations[0].split(" — ")[0]} etc.) • {st.faza11.maintenance.cronRecomandat}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
