/* Service worker for the installed categorizer.

   Deliberately small. It exists so the app opens instantly from the home
   screen and doesn't show a browser error page on a bad connection — not to
   cache financial data. Two rules keep it honest:

     · Only same-origin GETs are touched. Google Sheets and Firestore requests
       pass straight through, so nothing anyone would call "my transactions"
       is ever written to the cache. Firestore keeps its own offline store,
       which is the right place for it.
     · Anything version-bearing (/version.json, /api/*) is network-only, so the
       update pill in the app keeps working and cron endpoints are never served
       a stale answer.

   Build output under /assets/ is content-hashed, so it is cached forever and
   simply changes name on the next deploy; stale entries are swept on activate. */

const VERSION = 'v1';
const SHELL = `wa-shell-${VERSION}`;
const ASSETS = `wa-assets-${VERSION}`;
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then(cache => cache.add(new Request(SHELL_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('wa-') && k !== SHELL && k !== ASSETS)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isHashedAsset = (url) => url.pathname.startsWith('/assets/');
const isNeverCached = (url) => url.pathname.startsWith('/api/') || url.pathname === '/version.json';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url)) return;

  // Navigations: try the network so a deploy is picked up immediately, and
  // fall back to the cached shell only when offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cached = await caches.match(SHELL_URL);
        return cached || Response.error();
      }
    })());
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const res = await fetch(request);
      if (res.ok) {
        const cache = await caches.open(ASSETS);
        cache.put(request, res.clone());
      }
      return res;
    })());
  }
});

// Lets the page hand control to a waiting worker without a manual reload.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
