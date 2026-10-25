// Mjengo O'clock service worker: makes the app installable and quick to reopen on a slow
// connection. Hashed build assets are cached on first use; pages fall back to the cached
// app shell when offline. API calls, payments and live updates always go to the network.

const SHELL = "mjengo-shell-v1";
const ASSETS = "mjengo-assets-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname === "/sw.js") return;

  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.open(ASSETS).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain" } }))),
    );
  }
});
