/* ============================================================
 * StreamVerse — Service Worker (Faza 13: PWA + offload utilizator)
 *
 * Strategii:
 *  • Navigări (SPA shell): network-first, fallback cache „/” (shell),
 *    apoi pagină offline minimală generată inline.
 *  • GET /api/* publice: stale-while-revalidate — răspuns instant din
 *    cache + reîmprospătare în fundal → reduce origin-ul per utilizator
 *    (ținta 10M utilizatori simultani, Faza 10/12).
 *  • /_next/static + iconițe: cache-first (fișiere hash-uite, imutabile).
 *  • Niciodată cache: auth, user, colecții, stream/sign, maintain,
 *    health/status, HMR/websocket.
 *
 * Escap: deschide aplicația cu „?nosw” → SW se auto-dezinregistrează.
 * ============================================================ */

const VERSION = "sv13-1";
const SHELL_CACHE = `sv-shell-${VERSION}`;
const STATIC_CACHE = `sv-static-${VERSION}`;
const API_CACHE = `sv-api-${VERSION}`;
const SHELL_URL = "/";

const SHELL_ASSETS = [
  SHELL_URL,
  "/manifest.webmanifest",
  "/logo.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

// endpoint-uri API cu SWR (date publice de catalog — sigure la cache SW)
const API_SWR = [
  "/api/browse",
  "/api/library",
  "/api/channels",
  "/api/search",
  "/api/tmdb",
  "/api/tv",
  "/api/anime",
  "/api/music",
  "/api/sports",
  "/api/gaming",
  "/api/kids",
  "/api/news",
  "/api/fun",
  "/api/subtitles",
];

// niciodată cache (session/user-specific sau dinamice)
const API_NEVER = [
  "/api/auth",
  "/api/user",
  "/api/collections",
  "/api/stream",
  "/api/maintain",
  "/api/health",
  "/api/status",
  "/api/ai",
];

const NEVER_HOST_SUFFIXES = []; // rezervat (ex. CDN-uri terți)

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll individual — un asset lipsă nu blochează instalarea
      await Promise.all(
        SHELL_ASSETS.map((u) =>
          cache.add(new Request(u, { cache: "reload" })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("sv-") && !k.endsWith(VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function shouldNeverCache(pathname) {
  if (API_NEVER.some((p) => pathname.startsWith(p))) return true;
  if (NEVER_HOST_SUFFIXES.some((s) => pathname.includes(s))) return true;
  return false;
}

function isApiSwr(pathname) {
  return API_SWR.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?"));
}

/** pagină offline minimală (fallback navigări fără rețea și fără shell) */
function offlineResponse() {
  const html = `<!doctype html><html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StreamVerse — offline</title>
<style>body{background:#0a0a0f;color:#e4e4e7;font-family:system-ui,sans-serif;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{text-align:center;padding:2rem}
h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#a1a1aa;margin:0 0 1.2rem}
button{background:#7c3aed;color:#fff;border:0;border-radius:10px;padding:.6rem 1.2rem;
font-size:1rem;cursor:pointer}</style></head>
<body><div class="box"><h1>Ești offline</h1>
<p>StreamVerse nu poate fi încărcat fără conexiune. Verifică rețeaua și reîncearcă.</p>
<button onclick="location.reload()">Reîncearcă</button></div></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    // actualizăm shell-ul cache-uit (răspunsul „/” e același HTML SPA)
    if (fresh.ok) cache.put(SHELL_URL, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match(SHELL_URL, { ignoreSearch: true }));
    return cached ? cached.clone() : offlineResponse();
  }
}

async function handleApiSwr(request, url) {
  const cache = await caches.open(API_CACHE);
  const cacheKey = url.pathname + url.search;
  const cached = await cache.match(cacheKey);

  // reîmprospătare în fundal (best-effort, cu dedup în ramul SW)
  const refresh = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(cacheKey, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  if (cached) {
    // marcăm răspunsul din SW cache (distinct de headerele edge CDN)
    const headers = new Headers(cached.headers);
    headers.set("x-sw-cache", "hit");
    return new Response(cached.body, { status: cached.status, headers });
  }
  // prima cerere: așteptăm rețeaua; dacă pică → fallback offline curat
  const fresh = await refresh;
  if (fresh && fresh.ok) return fresh;
  return new Response(JSON.stringify({ error: "offline", stale: true }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function handleStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    return new Response("", { status: 504, headers: { "Cache-Control": "no-store" } });
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // doar same-origin
  if (url.origin !== self.location.origin) return;

  // HMR / devtools / websocket — în afara SW
  if (
    url.pathname.startsWith("/_next/webpack-hmr") ||
    url.pathname.includes("__nextjs") ||
    url.pathname.includes("hot-reload") ||
    req.headers.get("upgrade") === "websocket"
  ) {
    return;
  }

  // navigări (SPA)
  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(req));
    return;
  }

  // API publice — SWR
  if (url.pathname.startsWith("/api/")) {
    if (shouldNeverCache(url.pathname)) return; // lasă network-ul normal
    if (isApiSwr(url.pathname)) {
      event.respondWith(handleApiSwr(req, url));
    }
    return;
  }

  // static imutabil (hashuit) + iconițe + manifest
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icon-") ||
    url.pathname === "/apple-touch-icon.png" ||
    url.pathname === "/logo.svg" ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(handleStatic(req));
  }
});

// mesaje din pagină (skipWaiting explicit dacă e nevoie)
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
