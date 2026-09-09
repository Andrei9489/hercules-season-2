"use client";

// ============================================================
// FAZA 14 — NEON SYNC CENTER
// Buton în header + panou complet:
//   • stare conexiune REALĂ la Neon (ping măsurat, regiune, mărime DB)
//   • coada outbox (operațiunile făcute offline, în așteptare)
//   • buton „Sincronizează acum" → drain către /api/sync (idempotent)
//   • istoricul sincronizărilor din Neon (tabela sync_log)
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { CloudUpload, CheckCircle2, CircleDashed, RefreshCw, Wifi, WifiOff, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import {
  pendingOps, pendingCount, syncMeta, subscribeSync, drainQueue, pingNeon,
  currentDeviceId, type QueuedOp, type SyncMeta,
} from "@/lib/sync-outbox";

type SyncStatus = {
  connected: boolean;
  pingMs: number;
  authed?: boolean;
  db?: { provider: string; region: string; size: string; partitions: number; content: number };
  user?: { history: number; watchlist: number; favorites: number; collections: number; collectionItems: number; seenOps: number };
  lastSyncs?: { pushed: number; skipped: number; failed: number; durationMs: number; ok: boolean; device: string; createdAt: string }[];
};

function timeAgo(ts?: number): string {
  if (!ts) return "niciodată";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `acum ${s}s`;
  if (s < 3600) return `acum ${Math.floor(s / 60)}m`;
  if (s < 86400) return `acum ${Math.floor(s / 3600)}h`;
  return `acum ${Math.floor(s / 86400)}z`;
}

const TYPE_LABEL: Record<string, string> = {
  "user.watchlist.add": "Lista Mea +",
  "user.watchlist.toggle": "Lista Mea ±",
  "user.watchlist.remove": "Lista Mea −",
  "user.favorites.add": "Favorite +",
  "user.favorites.toggle": "Favorite ±",
  "user.favorites.remove": "Favorite −",
  "user.history.progress": "Progres vizionare",
  "collections.create": "Colecție nouă",
  "collections.update": "Colecție editată",
  "collections.delete": "Colecție ștearsă",
  "collections.add": "Item în colecție",
  "collections.remove": "Item din colecție",
};

export function SyncButton() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  const [ops, setOps] = useState<QueuedOp[]>([]);
  const [meta, setMeta] = useState<SyncMeta>({});
  const [online, setOnline] = useState(true);

  const refreshLocal = useCallback(() => {
    setPending(pendingCount());
    setOps(pendingOps());
    setMeta(syncMeta());
  }, []);

  const checkConnection = useCallback(async (silent = false) => {
    if (!silent) setChecking(true);
    const res = await pingNeon();
    setStatus((prev) => ({
      connected: res.connected,
      pingMs: res.pingMs,
      ...(res.data as SyncStatus | undefined),
    }));
    setChecking(false);
  }, []);

  useEffect(() => {
    refreshLocal();
    setOnline(navigator.onLine);
    const unsub = subscribeSync(() => { refreshLocal(); });
    const onOnline = () => { setOnline(true); void checkConnection(true); };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void checkConnection(true);
    const iv = setInterval(() => { if (navigator.onLine) void checkConnection(true); }, 30_000);
    return () => {
      unsub();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(iv);
    };
  }, [refreshLocal, checkConnection]);

  const doSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await drainQueue();
      if (res.ok && res.pushed > 0) {
        toast({ title: `✅ Sincronizat în Neon`, description: `${res.pushed} operațiuni aplicate • ${res.durationMs ?? 0}ms` });
      } else if (res.ok && res.skipped > 0) {
        toast({ title: `✅ Nimic nou de sincronizat`, description: `${res.skipped} operațiuni deja în Neon (idempotent)` });
      } else if (!res.ok && res.error) {
        toast({ title: "⚠️ Sincronizare eșuată", description: res.error });
      } else if (res.ok) {
        toast({ title: "✅ Totul e deja în Neon", description: "Coada este goală — datele tale sunt sincronizate." });
      }
      await checkConnection(true);
      refreshLocal();
    } finally {
      setSyncing(false);
    }
  }, [syncing, checkConnection, refreshLocal]);

  const dotColor = !online
    ? "bg-zinc-500"
    : syncing
      ? "bg-amber-400 animate-pulse"
      : pending > 0
        ? "bg-amber-400"
        : status?.connected
          ? "bg-emerald-400"
          : "bg-red-500";

  return (
    <>
      <button
        aria-label="Neon Sync — sincronizare și stare bază de date"
        onClick={() => { setOpen(true); refreshLocal(); if (navigator.onLine) void checkConnection(); }}
        className="relative flex h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-3 text-xs font-semibold text-zinc-300 ring-1 ring-zinc-800 transition hover:ring-emerald-600/60"
      >
        <CloudUpload className="h-4 w-4 text-emerald-400" />
        <span className="hidden md:inline">Neon Sync</span>
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
        {pending > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-black">
            {pending > 99 ? "99+" : pending}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto border-zinc-800 bg-[#0d0d14] text-zinc-200">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <CloudUpload className="h-5 w-5 text-emerald-400" /> Neon Sync
              <span className={`ml-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                !online ? "bg-zinc-800 text-zinc-400"
                : status?.connected ? "bg-emerald-500/15 text-emerald-300"
                : "bg-red-500/15 text-red-300"
              }`}>
                {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {!online ? "Offline" : status?.connected ? "Conectat" : "Deconectat"}
              </span>
            </DialogTitle>
          </DialogHeader>

          {/* stare DB reală */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-zinc-900/80 p-3 ring-1 ring-zinc-800">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Bază de date</p>
              <p className="mt-0.5 font-bold text-emerald-300">{status?.db?.provider ?? "…"}</p>
              <p className="text-zinc-500">{status?.db?.region ?? ""}</p>
            </div>
            <div className="rounded-lg bg-zinc-900/80 p-3 ring-1 ring-zinc-800">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Ping real</p>
              <p className="mt-0.5 font-bold text-zinc-100">
                {status ? `${status.pingMs} ms` : "…"}{" "}
                {checking && <Loader2 className="inline h-3 w-3 animate-spin text-zinc-500" />}
              </p>
              <p className="text-zinc-500">măsurat acum, pe server</p>
            </div>
            <div className="rounded-lg bg-zinc-900/80 p-3 ring-1 ring-zinc-800">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Bibliotecă (Neon)</p>
              <p className="mt-0.5 font-bold text-zinc-100">{status?.db?.content ?? "…"} conținuturi</p>
              <p className="text-zinc-500">{status?.db?.size ?? "…"} • {status?.db?.partitions ?? "…"} partiții</p>
            </div>
            <div className="rounded-lg bg-zinc-900/80 p-3 ring-1 ring-zinc-800">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Datele tale (Neon)</p>
              <p className="mt-0.5 font-bold text-zinc-100">
                {status?.user
                  ? `${status.user.watchlist + status.user.favorites} salvate • ${status.user.history} istoric`
                  : status?.authed ? "…" : "conectează-te"}
              </p>
              <p className="text-zinc-500">
                {status?.user ? `${status.user.collections} colecții • ${status.user.collectionItems} itemi` : "date 100% în cloud"}
              </p>
            </div>
          </div>

          {/* coada outbox */}
          <div className="rounded-lg bg-zinc-900/80 p-3 ring-1 ring-zinc-800">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                Coadă de sincronizare {pending > 0 && <span className="text-amber-300">• {pending} în așteptare</span>}
              </p>
              <button
                onClick={() => void doSync()}
                disabled={syncing || !online}
                className="flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Sincronizează acum
              </button>
            </div>
            {ops.length === 0 ? (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                Coada goală — ultima sincronizare {timeAgo(meta.lastSyncAt)}
                {meta.lastPushed !== undefined && meta.lastPushed > 0 && ` • ${meta.lastPushed} aplicate`}
              </p>
            ) : (
              <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                {ops.slice(-30).reverse().map((op) => (
                  <li key={op.opId} className="flex items-center gap-2 rounded-md bg-zinc-950/60 px-2 py-1.5 text-xs">
                    <CircleDashed className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">
                      {TYPE_LABEL[op.type] ?? op.type}
                    </span>
                    <span className="truncate text-zinc-400">{op.label}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-zinc-600">{timeAgo(op.queuedAt)}{op.tries > 0 && ` • ${op.tries} înc.`}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
              Când ești offline, acțiunile (Listă, Favorite, progres, colecții) se salvează local și ajung în
              Neon automat la revenirea conexiunii — sau acum, cu butonul. Re-trimiterea nu dublează nimic (idempotent).
              Dispozitiv: <span className="text-zinc-500">{currentDeviceId()}</span>
            </p>
          </div>

          {/* istoric din Neon (sync_log) */}
          {status?.lastSyncs && status.lastSyncs.length > 0 && (
            <div className="rounded-lg bg-zinc-900/80 p-3 ring-1 ring-zinc-800">
              <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Ultimele sincronizări (jurnal în Neon)</p>
              <ul className="mt-2 space-y-1 text-xs">
                {status.lastSyncs.slice(0, 6).map((s, i) => (
                  <li key={i} className="flex items-center gap-2 text-zinc-400">
                    <span className={`h-1.5 w-1.5 rounded-full ${s.ok ? "bg-emerald-400" : "bg-red-400"}`} />
                    <span className="text-zinc-300">{s.pushed} aplicate</span>
                    {s.skipped > 0 && <span>• {s.skipped} skip</span>}
                    {s.failed > 0 && <span className="text-red-300">• {s.failed} eșuate</span>}
                    <span className="text-zinc-600">• {s.durationMs}ms • {s.device}</span>
                    <span className="ml-auto text-[10px] text-zinc-600">
                      {new Date(s.createdAt).toLocaleString("ro-RO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
