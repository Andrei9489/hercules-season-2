"use client";

// ============================================================
// FAZA 16 — ManageView: GESTIONAREA BIBLIOTECII (postere + conținuturi)
// 3 taburi:
//   🎬 POSTERE    — grilă vizuală cu selecție MULTIPLĂ (checkbox pe card)
//                   + bară de acțiuni: „Șterge selectate (N)" (bulk delete)
//   🗃️ CONȚINUT   — tabel cu toate înregistrările (id, tip, provider, sursă)
//                   + aceeași selecție multiplă și ștergere în masă
//   🔍 DUPLICATE  — scan complet al bibliotecii (pe toate shard-urile):
//                   grupează duplicatele (titlu/sursă/ID identic), le
//                   ALERTEAZĂ clar și oferă eliminare automată (păstrează 1)
// Ștergerea e 100% în Neon (local + compute-uri remote prin content_shard_map),
// auditată în manage_log și invalidă cache-ul de căutare.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Database, Trash2, Search, CheckSquare, Square, ChevronLeft, ChevronRight, AlertTriangle, CopyX } from "lucide-react";
import { api } from "./api";

type PosterItem = {
  id: number; title: string; contentType: string; provider: string;
  thumbnail: string | null; year: number | null; popularity: number; views: number;
  createdAt: string | null;
};

type ContentItem = PosterItem & {
  externalId: string; sourceType: string; sourceUrl: string | null;
  createdBy: string | null;
};

type DupGroup = {
  key: string; reason: string; reasonLabel: string; count: number; extra: number;
  items: { id: number; title: string; contentType: string; provider: string;
           sourceUrl: string | null; thumbnail: string | null; shardName: string }[];
};

type ListResp = { ok: boolean; items: PosterItem[]; total: number; limit: number; offset: number };
type ContentResp = ListResp & { items: ContentItem[] };
type ScanResp = { ok: boolean; groups: DupGroup[]; totalGroups: number; totalExtraRows: number; scannedShards: number; scanMs: number };

const PAGE = 24;

const REASON_STYLE: Record<string, string> = {
  title: "bg-sky-500/10 text-sky-300 ring-sky-600/30",
  source: "bg-purple-500/10 text-purple-300 ring-purple-600/30",
  external_id: "bg-rose-500/10 text-rose-300 ring-rose-600/30",
};

export function ManageView() {
  const [tab, setTab] = useState<"posters" | "content" | "duplicates">("posters");

  // listare + selecție
  const [posters, setPosters] = useState<PosterItem[]>([]);
  const [contents, setContents] = useState<ContentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // duplicates
  const [scan, setScan] = useState<ScanResp | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dedupeKeep, setDedupeKeep] = useState<"first" | "best" | "newest">("first");

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (off: number) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ tab: tab === "duplicates" ? "posters" : tab, limit: String(PAGE), offset: String(off) });
      if (q.trim()) qs.set("q", q.trim());
      if (tab === "content") {
        const r = await api.manage<ContentResp>(qs.toString());
        setContents(r.items || []);
        setTotal(r.total || 0);
      } else {
        const r = await api.manage<ListResp>(qs.toString());
        setPosters(r.items || []);
        setTotal(r.total || 0);
      }
      setOffset(off);
      setSelected(new Set());
    } catch (e) {
      toast({
        title: "Eroare la încărcarea bibliotecii",
        description: String((e as { message?: string })?.message || e).slice(0, 200),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [tab, q]);

  useEffect(() => { load(0); }, [load]);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const r = await api.manage<ScanResp>("tab=duplicates");
      setScan(r);
      if (r.totalGroups === 0) {
        toast({ title: "✅ Niciun duplicat găsit — biblioteca e curată" });
      } else {
        toast({
          title: `⚠️ ${r.totalGroups} grupuri de duplicate — ${r.totalExtraRows} conținuturi în plus`,
          description: `${r.scannedShards} shard-uri scanate în ${r.scanMs}ms — selectate mai jos pentru eliminare.`,
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "Eroare la scanarea duplicatelor", description: "Verifică conexiunea și reîncearcă scanarea.", variant: "destructive" });
    } finally {
      setScanning(false);
    }
  }, []);

  const toggleSel = (id: number) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const allCurrentIds = tab === "content" ? contents.map((c) => c.id) : posters.map((p) => p.id);
  const allSelected = allCurrentIds.length > 0 && allCurrentIds.every((id) => selected.has(id));

  const toggleAll = () => {
    setSelected((prev) => (allSelected ? new Set() : new Set(allCurrentIds)));
  };

  const doDelete = async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const r = await api.managePost<{ deleted: number; local: number; remote: number; missing: number; detail: { shard: string; deleted: number }[] }>({
        action: "delete",
        ids: [...selected],
      });
      toast({
        title: `🗑️ ${r.deleted} conținuturi șterse din Neon`,
        description: `${r.local} pe primar${r.remote ? ` • ${r.remote} pe compute remote (${r.detail.map((d) => `${d.shard}: ${d.deleted}`).join(", ")})` : ""}${r.missing ? ` • ${r.missing} inexistent(e)` : ""} • operațiune înregistrată în manage_log`,
      });
      setConfirmDelete(false);
      setSelected(new Set());
      setScan(null);
      await load(offset);
    } catch (e) {
      const msg = String((e as { message?: string })?.message || e);
      toast({
        title: msg.includes("401") ? "Autentifică-te pentru a gestiona biblioteca" : "Eroare la ștergere",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  const doDedupe = async () => {
    setDeleting(true);
    try {
      const r = await api.managePost<{ groupsProcessed: number; deleted: number }>({
        action: "dedupe",
        keep: dedupeKeep,
      });
      toast({
        title: r.deleted > 0 ? `✅ ${r.deleted} duplicate eliminate din ${r.groupsProcessed} grupuri` : "Niciun duplicat de eliminat",
        description: r.deleted > 0 ? `Strategie: păstrează ${dedupeKeep === "first" ? "primul adăugat" : dedupeKeep === "best" ? "cel mai bun" : "cel mai recent"} • audit în manage_log` : undefined,
      });
      setScan(null);
      await load(0);
    } catch (e) {
      const msg = String((e as { message?: string })?.message || e);
      toast({
        title: msg.includes("401") ? "Autentifică-te pentru a gestiona biblioteca" : "Eroare la deduplicare",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="px-4 sm:px-6 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">🛠️ Gestionare bibliotecă</h1>
          <p className="mt-1 text-xs text-zinc-500">
            Ștergere multiplă de <b className="text-zinc-300">postere</b> și <b className="text-zinc-300">conținuturi</b> • detecție
            <b className="text-zinc-300"> duplicate</b> cu alertare • operațiuni 100% în Neon, auditate în manage_log.
            {total > 0 && <b className="text-zinc-300"> • {total.toLocaleString("ro-RO")} înregistrări</b>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(0)}
            placeholder="Caută după titlu…"
            className="h-9 w-44 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-600/40"
          />
        </div>
      </div>

      {/* tab-uri */}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Gestionare">
        {([
          ["posters", "🎬 Postere"],
          ["content", "🗃️ Conținut"],
          ["duplicates", `🔍 Duplicate${scan ? ` (${scan.totalGroups})` : ""}`],
        ] as [typeof tab, string][]).map(([v, label]) => (
          <button
            key={v}
            role="tab"
            aria-selected={tab === v}
            onClick={() => { setTab(v); if (v === "duplicates" && !scan) void runScan(); }}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              tab === v ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200 ring-1 ring-zinc-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* BARĂ DE ACȚIUNI (selecție multiplă) */}
      {(tab === "posters" || tab === "content") && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2">
          <button
            onClick={toggleAll}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-bold text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800 transition"
          >
            {allSelected ? <CheckSquare className="h-4 w-4 text-red-400" /> : <Square className="h-4 w-4" />}
            {allSelected ? "Deselectează pagina" : "Selectează pagina"}
          </button>
          <span className="text-xs text-zinc-500">
            {selected.size > 0 ? <b className="text-red-400">{selected.size} selectate</b> : "nimic selectat"}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => selected.size > 0 && setConfirmDelete(true)}
            disabled={selected.size === 0 || deleting}
            className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-40 transition"
            data-bulk-delete
          >
            <Trash2 className="h-4 w-4" />
            Șterge selectate {selected.size > 0 ? `(${selected.size})` : ""}
          </button>
        </div>
      )}

      {/* ---------- TAB: POSTERE (grilă + checkbox) ---------- */}
      {tab === "posters" && (
        loading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-[2/3] animate-pulse rounded-xl bg-zinc-900" />
            ))}
          </div>
        ) : posters.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6" data-posters-grid>
            {posters.map((p) => {
              const sel = selected.has(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => toggleSel(p.id)}
                  aria-pressed={sel}
                  className={`group relative overflow-hidden rounded-xl text-left ring-2 transition ${
                    sel ? "ring-red-500" : "ring-zinc-800 hover:ring-zinc-600"
                  }`}
                >
                  <div className="aspect-[2/3] w-full bg-zinc-900">
                    {p.thumbnail ? (
                      <img src={p.thumbnail} alt={p.title} loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-zinc-700"><Database className="h-8 w-8" /></div>
                    )}
                  </div>
                  <div className={`absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md ${sel ? "bg-red-600" : "bg-black/60 ring-1 ring-white/20"}`}>
                    {sel ? <CheckSquare className="h-4 w-4 text-white" /> : <Square className="h-4 w-4 text-white/70" />}
                  </div>
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-2 pb-2 pt-6">
                    <p className="truncate text-[11px] font-bold text-white">{p.title}</p>
                    <p className="text-[10px] text-zinc-400">#{p.id} • {p.contentType} • {p.provider}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )
      )}

      {/* ---------- TAB: CONȚINUT (tabel + checkbox) ---------- */}
      {tab === "content" && (
        loading ? (
          <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-zinc-900" />)}</div>
        ) : contents.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800" data-content-table>
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-zinc-900/80 text-zinc-400">
                <tr>
                  <th className="w-10 px-3 py-2.5">
                    <button onClick={toggleAll} aria-label="Selectează tot">
                      {allSelected ? <CheckSquare className="h-4 w-4 text-red-400" /> : <Square className="h-4 w-4" />}
                    </button>
                  </th>
                  <th className="px-2 py-2.5">ID</th>
                  <th className="px-2 py-2.5">Titlu</th>
                  <th className="px-2 py-2.5">Tip</th>
                  <th className="px-2 py-2.5">Provider</th>
                  <th className="px-2 py-2.5">Sursă</th>
                  <th className="px-2 py-2.5">Adăugat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {contents.map((c) => {
                  const sel = selected.has(c.id);
                  return (
                    <tr key={c.id} onClick={() => toggleSel(c.id)} className={`cursor-pointer transition ${sel ? "bg-red-950/40" : "hover:bg-zinc-900/60"}`}>
                      <td className="px-3 py-2">
                        {sel ? <CheckSquare className="h-4 w-4 text-red-400" /> : <Square className="h-4 w-4 text-zinc-600" />}
                      </td>
                      <td className="px-2 py-2 font-mono text-zinc-500">{c.id}</td>
                      <td className="max-w-[240px] truncate px-2 py-2 font-bold text-zinc-200">{c.title}</td>
                      <td className="px-2 py-2 text-zinc-400">{c.contentType}</td>
                      <td className="px-2 py-2 text-zinc-400">{c.provider}</td>
                      <td className="max-w-[220px] truncate px-2 py-2 font-mono text-[10px] text-zinc-500">
                        {c.sourceUrl || (c.sourceType === "embed" ? "(cod embed)" : c.sourceType)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-[10px] text-zinc-600">
                        {c.createdAt ? new Date(c.createdAt).toLocaleDateString("ro-RO") : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ---------- TAB: DUPLICATE ---------- */}
      {tab === "duplicates" && (
        <div className="space-y-4" data-duplicates-panel>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-3">
            <button
              onClick={runScan}
              disabled={scanning}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-50 transition"
              data-scan-duplicates
            >
              <Search className="h-4 w-4" />
              {scanning ? "Se scanează…" : "Scanează duplicatele"}
            </button>
            <p className="text-[11px] text-zinc-500">
              Scan complet pe toate shard-urile active: titluri identice (fără diacritice), aceeași sursă, același ID.
            </p>
          </div>

          {scan && scan.totalGroups > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-500/10 px-4 py-3 ring-1 ring-amber-600/40" data-duplicate-summary>
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black text-amber-200">
                    ⚠️ {scan.totalGroups} grupuri de duplicate — {scan.totalExtraRows} conținuturi în plus ({scan.scannedShards} shard-uri, {scan.scanMs}ms)
                  </p>
                  <p className="text-[11px] text-amber-200/70">
                    Aceste postere/conținuturi există deja — nu ar fi trebuit să fie încărcate de două ori. Elimină-le mai jos.
                  </p>
                </div>
                <select
                  value={dedupeKeep}
                  onChange={(e) => setDedupeKeep(e.target.value as typeof dedupeKeep)}
                  aria-label="Strategie de păstrare"
                  className="h-8 rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200"
                >
                  <option value="first">Păstrează primul adăugat</option>
                  <option value="best">Păstrează cel mai recent ID</option>
                  <option value="newest">Păstrează cel mai nou (dată)</option>
                </select>
                <button
                  onClick={doDedupe}
                  disabled={deleting}
                  className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-500 disabled:opacity-50 transition"
                  data-auto-dedupe
                >
                  <CopyX className="h-4 w-4" />
                  Elimină automat duplicatele
                </button>
              </div>

              <div className="space-y-3">
                {scan.groups.map((g) => (
                  <div key={g.key} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ring-1 ${REASON_STYLE[g.reason] || "bg-zinc-800 text-zinc-300 ring-zinc-700"}`}>
                        {g.reasonLabel}
                      </span>
                      <span className="text-xs font-bold text-zinc-300">{g.count} exemplare • {g.extra} în plus</span>
                    </div>
                    <div className="space-y-1.5">
                      {g.items.map((it, idx) => (
                        <div key={`${it.shardName}-${it.id}`} className="flex items-center gap-2 rounded-lg bg-zinc-900/70 px-2.5 py-1.5">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${idx === 0 ? "bg-emerald-600/20 text-emerald-300" : "bg-red-600/20 text-red-300"}`}>
                            {idx === 0 ? "PĂSTREAZĂ" : "DUPLICAT"}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{it.title}</span>
                          <span className="font-mono text-[10px] text-zinc-500">#{it.id}</span>
                          <span className="hidden text-[10px] text-zinc-600 sm:inline">{it.contentType} • {it.provider} • {it.shardName}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {scan && scan.totalGroups === 0 && !scanning && (
            <div className="flex flex-col items-center rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-6 py-10 text-center">
              <CheckSquare className="mb-2 h-8 w-8 text-emerald-400" />
              <p className="text-sm font-black text-emerald-300">Biblioteca e curată — niciun duplicat</p>
              <p className="mt-1 max-w-md text-xs text-zinc-500">
                Garda la încărcare blochează automat al doilea conținut identic (aceeași sursă, același ID sau același titlu + tip),
                deci duplicatele nu ar trebui să apară deloc.
              </p>
            </div>
          )}
        </div>
      )}

      {/* PAGINARE */}
      {(tab === "posters" || tab === "content") && totalPages > 1 && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-1.5">
          <button
            onClick={() => load(offset - PAGE)}
            disabled={offset === 0}
            className="flex h-9 items-center gap-1 rounded-lg bg-zinc-900 px-3 text-xs font-bold text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800 disabled:opacity-30 transition"
          >
            <ChevronLeft className="h-4 w-4" /> Precedenta
          </button>
          <span className="px-2 text-xs text-zinc-500">
            pagina {Math.floor(offset / PAGE) + 1} / {totalPages.toLocaleString("ro-RO")}
          </span>
          <button
            onClick={() => load(offset + PAGE)}
            disabled={offset + PAGE >= total}
            className="flex h-9 items-center gap-1 rounded-lg bg-zinc-900 px-3 text-xs font-bold text-zinc-300 ring-1 ring-zinc-800 hover:bg-zinc-800 disabled:opacity-30 transition"
          >
            Următoarea <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* CONFIRMARE ȘTERGERE */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
          <AlertDialogHeader>
            <AlertDialogTitle>Ștergi {selected.size} conținuturi din Neon?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              Acțiunea e <b className="text-zinc-200">definitivă</b>: posterele și conținuturile selectate dispar din
              bibliotecă, din căutare și din listări. Se curăță și statisticile de redare asociate. Operațiunea e
              înregistrată în manage_log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-zinc-900 text-zinc-200 ring-1 ring-zinc-800 hover:bg-zinc-800">Anulează</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void doDelete(); }}
              disabled={deleting}
              className="bg-red-600 font-bold hover:bg-red-500"
              data-confirm-delete
            >
              {deleting ? "Se șterge…" : `Șterge definitiv (${selected.size})`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/60 px-6 py-16 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-zinc-900 ring-1 ring-zinc-800">
        <Database className="h-8 w-8 text-zinc-600" />
      </div>
      <h2 className="text-lg font-black text-zinc-300">Biblioteca e goală</h2>
      <p className="mt-2 max-w-md text-sm text-zinc-500">
        Nicio înregistrare de gestionat. Adaugă conținut din meniurile platformei, apoi revino aici pentru
        ștergere multiplă și detecție de duplicate.
      </p>
    </div>
  );
}
