// ScamGuard SOS service worker: keeps the app (SOS button, hotlines, checker) usable offline.
const CACHE = "sg-v2";
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
  if (u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/t/") || u.pathname.startsWith("/admin")) return;
  if (r.mode === "navigate") {
    // The app page, or a partner's page such as /fwd. Other pages (privacy etc.) aren't kept offline.
    const p = u.pathname.replace(/\/$/, "") || "/";
    const key = (p === "/" || (/^\/[a-z0-9-]{2,30}$/.test(p) && !/^\/(privacy|security|delete-data)$/.test(p))) ? p : null;
    // Always try the network first so updates show straight away; fall back to the saved copy offline.
    e.respondWith(fetch(r).then(res => {
      if (key && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key || r).then(m => m || caches.match("/"))));
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r)));
});
