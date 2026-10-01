// ScamGuard SOS service worker: keeps the app (SOS button, hotlines, checker) usable offline.
const CACHE = "sg-v1";
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/", "/icons/icon-192.png", "/icon.svg"])));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/t/")) return;
  if (r.mode === "navigate") {
    // Always try the network first so updates show straight away; fall back to the saved copy offline.
    e.respondWith(fetch(r).then(res => {
      if (u.pathname === "/" && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put("/", copy)); }
      return res;
    }).catch(() => caches.match(u.pathname === "/" ? "/" : r).then(m => m || caches.match("/"))));
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r)));
});
