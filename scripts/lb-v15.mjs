// ============================================================
// FAZA 15 — LOAD BALANCER DE PRODUCȚIE (L7) pentru clusterul Next.js
// Bun.serve • round-robin pe upstream-uri SĂNĂTOASE • health-check
// activ la 5s (eject automat la 2 eșecuri, re-admitere la 2 OK) •
// retry pe următorul upstream la conexiune eșuată • anteturi
// X-Forwarded-* • observabilitate: GET /lb-status (JSON real)
// Rulare: PORT=3210 bun scripts/lb-v15.mjs
// ============================================================
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 3210);
const UPSTREAMS = (process.env.UPSTREAMS || "127.0.0.1:3101,127.0.0.1:3102,127.0.0.1:3103,127.0.0.1:3104")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const HEALTH_PATH = "/api/health";
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_500;
const EJECT_AFTER = 2;   // eșecuri consecutive → ejected
const ADMIT_AFTER = 2;   // OK-uri consecutive → readmis

const upstreams = UPSTREAMS.map((u) => ({
  addr: u,
  healthy: true,
  consecFail: 0,
  consecOk: 0,
  reqs: 0,
  errors: 0,
  lastCheckAt: 0,
  lastLatencyMs: 0,
  ejectedAt: 0,
}));

let rr = 0;
let totalProxied = 0;
let totalRetries = 0;

function healthyList() {
  return upstreams.filter((u) => u.healthy);
}

function pickNext(exclude) {
  const list = healthyList().filter((u) => !exclude || u.addr !== exclude);
  if (list.length === 0) return null;
  const u = list[rr % list.length];
  rr++;
  return u;
}

async function probe(u) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`http://${u.addr}${HEALTH_PATH}`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    u.lastLatencyMs = Date.now() - t0;
    u.lastCheckAt = Date.now();
    if (res.ok) {
      u.consecOk++;
      u.consecFail = 0;
      if (!u.healthy && u.consecOk >= ADMIT_AFTER) {
        u.healthy = true;
        u.ejectedAt = 0;
        console.log(`[lb] ${u.addr} READMIS (${u.lastLatencyMs}ms)`);
      }
    } else {
      u.consecOk = 0;
      u.consecFail++;
      if (u.healthy && u.consecFail >= EJECT_AFTER) {
        u.healthy = false;
        u.ejectedAt = Date.now();
        console.log(`[lb] ${u.addr} EJECTAT (HTTP ${res.status})`);
      }
    }
  } catch (e) {
    u.lastLatencyMs = Date.now() - t0;
    u.lastCheckAt = Date.now();
    u.consecOk = 0;
    u.consecFail++;
    if (u.healthy && u.consecFail >= EJECT_AFTER) {
      u.healthy = false;
      u.ejectedAt = Date.now();
      console.log(`[lb] ${u.addr} EJECTAT (${String(e?.message || e).slice(0, 60)})`);
    }
  }
}

function startHealthLoop() {
  for (const u of upstreams) void probe(u);
  setInterval(() => {
    for (const u of upstreams) void probe(u);
  }, HEALTH_INTERVAL_MS);
}

// ---------- Proxy HTTP (round-robin + retry) ----------
function proxy(req, res) {
  let first = null;
  let tried = new Set();

  const attempt = () => {
    const u = pickNext(first);
    if (!u) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no-healthy-upstream", lb: "v15", total: upstreams.length }));
      return;
    }
    if (!first) first = u.addr;
    tried.add(u.addr);
    u.reqs++;
    totalProxied++;

    const headers = { ...req.headers };
    headers["x-forwarded-for"] = req.socket.remoteAddress || "";
    headers["x-forwarded-proto"] = "http";
    headers["x-forwarded-host"] = req.headers.host || "";
    headers["x-lb"] = "v15";
    headers["connection"] = "close";

    const preq = http.request(
      {
        host: u.addr.split(":")[0],
        port: Number(u.addr.split(":")[1]),
        method: req.method,
        path: req.url,
        headers,
      },
      (pres) => {
        res.writeHead(pres.statusCode || 502, { ...pres.headers, "x-lb-upstream": u.addr });
        pres.pipe(res);
      }
    );
    preq.on("error", () => {
      u.errors++;
      totalRetries++;
      if (tried.size < healthyList().length + 1 && tried.size < upstreams.length) {
        attempt(); // retry pe următorul upstream sănătos
      } else {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream-failed", tried: [...tried] }));
      }
    });
    req.pipe(preq);
  };
  attempt();
}

// ---------- LB-status (JSON) ----------
function status(req, res) {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(
    JSON.stringify(
      {
        lb: "streamverse-v15",
        strategy: "round-robin pe upstream-uri sănătoase + retry",
        health: { path: HEALTH_PATH, intervalMs: HEALTH_INTERVAL_MS, ejectAfter: EJECT_AFTER, admitAfter: ADMIT_AFTER },
        totalProxied,
        totalRetries,
        upstreams: upstreams.map((u) => ({
          addr: u.addr,
          healthy: u.healthy,
          reqs: u.reqs,
          errors: u.errors,
          lastLatencyMs: u.lastLatencyMs,
          lastCheckAt: u.lastCheckAt ? new Date(u.lastCheckAt).toISOString() : null,
          ejectedAt: u.ejectedAt ? new Date(u.ejectedAt).toISOString() : null,
        })),
      },
      null,
      2
    )
  );
}

const http = await import("node:http");
const server = createServer((req, res) => {
  if (req.url === "/lb-status") return status(req, res);
  proxy(req, res);
});

server.listen(PORT, () => {
  console.log(`[lb] Load balancer v15 pe :${PORT} → ${upstreams.map((u) => u.addr).join(", ")}`);
  startHealthLoop();
});

// grace: HTTP/1.1 keep-alive pe LB, close pe upstream (connection: close)
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
