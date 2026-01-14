const CACHE_VERSION = "worklog-cache-v120"; // <-- JEDES Update hochzählen!
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_VERSION ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

// stale-while-revalidate for static assets
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request); // <-- WICHTIG: kein ignoreSearch

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || Response.error();
}

// network-first for navigation
async function networkFirstIndex() {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch("./index.html", { cache: "no-store" });
    if (fresh && fresh.ok) cache.put("./index.html", fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match("./index.html");
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;

  // Navigation (opening the app / switching tabs)
  if (req.mode === "navigate") {
    event.respondWith(networkFirstIndex());
    return;
  }

  // Static assets
  if (
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".json") ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/index.html")
  ) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Default
  event.respondWith((async () => {
    const cached = await caches.match(req);
    return cached || fetch(req);
  })());
});
