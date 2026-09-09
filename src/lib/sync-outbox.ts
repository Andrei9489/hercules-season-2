"use client";

// ============================================================
// FAZA 14 — NEON SYNC OUTBOX (client)
// Coadă de operațiuni făcute OFFLINE, salvată în localStorage,
// sincronizată către /api/sync (Neon) cu IDEMPOTENȚĂ:
//   • fiecare op are opId UUID — reaplicat = skip pe server;
//   • colecțiile create offline primesc clientRef (UUID local),
//     serverul întoarce serverId → rescriem referințele local;
//   • auto-sync: la revenirea online, la interval și la focus.
// ============================================================

const QUEUE_KEY = "neon-sync-outbox-v1";
const DEVICE_KEY = "neon-device-id";
const META_KEY = "neon-sync-meta-v1";
const MAX_QUEUE = 500;
const MAX_TRIES = 5;

export type QueuedOp = {
  opId: string;
  type: string;
  payload: Record<string, unknown>;
  url: string;
  queuedAt: number;
  tries: number;
  label: string;
};

export type SyncMeta = {
  lastSyncAt?: number;
  lastPushed?: number;
  lastSkipped?: number;
  lastFailed?: number;
  lastError?: string;
};

export type SyncResult = {
  ok: boolean;
  pushed: number;
  skipped: number;
  failed: number;
  results?: { opId: string; status: string; error?: string; serverId?: string }[];
  durationMs?: number;
  error?: string;
};

// ---------- bus intern (UI-ul se abonează pentru badge / refresh) ----------
type Listener = () => void;
const listeners = new Set<Listener>();
function emit() {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}
export function subscribeSync(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- stocare locală ----------
function deviceId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `web-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function readQueue(): QueuedOp[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]") as QueuedOp[];
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedOp[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE)));
  emit();
}

function readMeta(): SyncMeta {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || "{}") as SyncMeta;
  } catch {
    return {};
  }
}

function writeMeta(m: SyncMeta): void {
  localStorage.setItem(META_KEY, JSON.stringify(m));
  emit();
}

export function pendingOps(): QueuedOp[] {
  return readQueue();
}

export function pendingCount(): number {
  return readQueue().length;
}

export function syncMeta(): SyncMeta {
  return readMeta();
}

export function currentDeviceId(): string {
  return deviceId();
}

// ---------- maparea cererilor scrise → operațiuni sync ----------
function mapBodyToOp(url: string, body: Record<string, unknown>): { type: string; payload: Record<string, unknown>; label: string } | null {
  if (url === "/api/user") {
    const action = String(body.action || "");
    const kind = String(body.kind || "");
    const media = body.media as Record<string, unknown> | undefined;
    const title = String(media?.title || media?.mediaId || "element");
    if ((kind === "watchlist" || kind === "favorites") && media) {
      if (action === "remove") return { type: `user.${kind}.remove`, payload: { media }, label: `eliminare din ${kind === "watchlist" ? "Lista Mea" : "Favorite"}: ${title}` };
      if (action === "add" || action === "toggle") return { type: `user.${kind}.${action}`, payload: { media }, label: `${kind === "watchlist" ? "Lista Mea" : "Favorite"}: ${title}` };
    }
    if (kind === "history" && media && (action === "progress" || action === "add")) {
      return { type: "user.history.progress", payload: { media, progress: body.progress, duration: body.duration, trailerKey: body.trailerKey }, label: `progres: ${title}` };
    }
    return null;
  }
  if (url === "/api/collections") {
    const action = String(body.action || "");
    const name = String(body.name || "colecție");
    if (action === "create") return { type: "collections.create", payload: { name, description: body.description, isPublic: body.isPublic }, label: `creare colecție: ${name}` };
    if (action === "update" && body.id) return { type: "collections.update", payload: { id: body.id, name: body.name, description: body.description }, label: `actualizare colecție: ${name}` };
    if (action === "delete" && body.id) return { type: "collections.delete", payload: { id: body.id }, label: `ștergere colecție` };
    if (action === "add" && body.id) return { type: "collections.add", payload: { id: body.id, contentId: body.contentId }, label: `adăugare în colecție: ${name}` };
    if (action === "remove" && body.id) return { type: "collections.remove", payload: { id: body.id, contentId: body.contentId }, label: `eliminare din colecție` };
    return null;
  }
  return null;
}

/** Captura o cerere de scriere când suntem OFFLINE (sau fetch-ul pică).
 *  Întoarce un răspuns sintetic „queued" pentru UI optimist. */
export function enqueueOfflineWrite(url: string, body: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  const mapped = mapBodyToOp(url, body);
  if (!mapped) return null; // nu știm să o mapăm → lăsați eroarea normală

  const queue = readQueue();
  let synthetic: Record<string, unknown> = { ok: true, queued: true };

  if (mapped.type === "collections.create") {
    // clientRef = opId; serverul va întoarce serverId la sincronizare
    const clientRef = crypto.randomUUID();
    synthetic = { ok: true, queued: true, id: clientRef, itemsCount: 0 };
    queue.push({
      opId: clientRef,
      type: mapped.type,
      payload: { ...mapped.payload, clientRef },
      url,
      queuedAt: Date.now(),
      tries: 0,
      label: mapped.label,
    });
  } else {
    queue.push({
      opId: crypto.randomUUID(),
      type: mapped.type,
      payload: mapped.payload,
      url,
      queuedAt: Date.now(),
      tries: 0,
      label: mapped.label,
    });
    if (mapped.type.startsWith("user.")) {
      synthetic = {
        ok: true,
        queued: true,
        active: !mapped.type.endsWith(".remove"),
      };
    }
  }
  writeQueue(queue);
  return synthetic;
}

/** Apelat după ce o sincronizare a reușit: rescriem clientRef-urile
 *  de colecții cu serverId-urile reale în toată coada rămasă. */
function rewriteRefs(results: { opId: string; status: string; serverId?: string }[]): void {
  const map = new Map<string, string>();
  for (const r of results) if (r.serverId) map.set(r.opId, r.serverId);
  if (map.size === 0) return;
  const queue = readQueue().map((op) => {
    const sid = map.get(op.payload?.id as string);
    if (sid) op.payload = { ...op.payload, id: sid };
    return op;
  });
  writeQueue(queue);
}

// ---------- DRAIN: trimite coada către Neon ----------
let draining = false;

export async function drainQueue(): Promise<SyncResult> {
  if (typeof window === "undefined") return { ok: false, pushed: 0, skipped: 0, failed: 0, error: "ssr" };
  if (draining) return { ok: false, pushed: 0, skipped: 0, failed: 0, error: "already-draining" };
  const queue = readQueue();
  if (queue.length === 0) {
    const meta = { ...readMeta(), lastSyncAt: Date.now() };
    writeMeta(meta);
    return { ok: true, pushed: 0, skipped: 0, failed: 0 };
  }
  draining = true;
  emit();
  try {
    const batch = queue.filter((o) => o.tries < MAX_TRIES).slice(0, 100);
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: deviceId(), ops: batch.map(({ opId, type, payload }) => ({ opId, type, payload })) }),
    });
    if (!res.ok) {
      const txt = await res.text();
      const failed: SyncResult = { ok: false, pushed: 0, skipped: 0, failed: batch.length, error: `API ${res.status}: ${txt.slice(0, 120)}` };
      writeMeta({ ...readMeta(), lastError: failed.error });
      return failed;
    }
    const data = (await res.json()) as SyncResult;
    const okIds = new Set((data.results || []).filter((r) => r.status === "applied" || r.status === "skipped").map((r) => r.opId));
    const retryIds = new Set((data.results || []).filter((r) => r.status === "failed").map((r) => r.opId));
    // eliminăm cele aplicate/skipped; incrementăm tries pentru cele eșuate
    const remaining = readQueue()
      .map((op) => (retryIds.has(op.opId) ? { ...op, tries: op.tries + 1 } : op))
      .filter((op) => !okIds.has(op.opId));
    writeQueue(remaining);
    rewriteRefs(data.results || []);
    writeMeta({
      lastSyncAt: Date.now(),
      lastPushed: data.pushed,
      lastSkipped: data.skipped,
      lastFailed: data.failed,
      lastError: data.failed > 0 ? `${data.failed} operațiuni eșuate` : undefined,
    });
    if (data.pushed > 0) emit(); // UI reîncarcă listele
    return data;
  } catch (e) {
    const error = String(e).slice(0, 160);
    writeMeta({ ...readMeta(), lastError: error });
    return { ok: false, pushed: 0, skipped: 0, failed: 0, error };
  } finally {
    draining = false;
    emit();
  }
}

/** Verifică conexiunea reală la Neon prin /api/sync (GET). */
export async function pingNeon(): Promise<{ connected: boolean; pingMs: number; data?: Record<string, unknown> }> {
  const t0 = Date.now();
  try {
    const res = await fetch("/api/sync", { cache: "no-store" });
    const data = (await res.json()) as Record<string, unknown>;
    return { connected: !!data.connected, pingMs: Date.now() - t0, data };
  } catch {
    return { connected: false, pingMs: Date.now() - t0 };
  }
}

// ---------- auto-sync global (instalat o singură dată) ----------
let installed = false;
export function installAutoSync(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("online", () => { void drainQueue(); });
  window.addEventListener("focus", () => { if (pendingCount() > 0) void drainQueue(); });
  setInterval(() => { if (navigator.onLine && pendingCount() > 0) void drainQueue(); }, 60_000);
}
