// Nerodolla service worker — network-first for HTML, cache-first for hashed assets
const CACHE = 'nerohedge-v8';

self.addEventListener('install', e => {
  // Skip waiting so new SW activates immediately
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Let API/proxy calls go straight to network
  if (url.pathname.startsWith('/bot/') || url.pathname.startsWith('/api/')
      || url.pathname.startsWith('/lighter/') || url.pathname.startsWith('/lws/')) return;

  // Navigation requests (HTML pages) — always network-first so new builds are picked up
  if (e.request.mode === 'navigate' || url.pathname === '/') {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          }
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Hashed assets (/assets/*) — cache-first (immutable, hash changes on rebuild)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok && url.origin === self.location.origin) {
          caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        }
        return resp;
      });
    })
  );
});
