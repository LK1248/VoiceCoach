// Minimal service worker: makes Voice Coach installable and gives an offline fallback
// for the app shell. Network-first with revalidation, so a new deploy is never mixed
// with stale modules (see tools/stamp_version.py). Audio samples are left to the
// browser's normal HTTP cache (not intercepted).
const CACHE = 'voice-coach-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes('/samples/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req)) || Response.error();
    }
  })());
});
