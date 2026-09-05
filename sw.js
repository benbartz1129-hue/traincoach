// ══════════════════════════════════════════════════════════════════════════
// BRB Training — Service Worker
//
// Caching strategy, deliberately simple:
//   • App shell (index.html, fonts)  → stale-while-revalidate.
//       Opens instantly from cache, then quietly updates in the background so
//       the next open has the latest deploy.
//   • API calls (/kv, /claude, /weather, /strava-token) → NEVER cached.
//       These are live data and auth. Serving a stale KV archive or a cached
//       AI response would be worse than failing, so they always hit network.
//   • Everything else same-origin → cache-first with network fallback.
//
// Bump CACHE_VERSION on deploys that change index.html so clients refresh.
// ══════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'brb-v2';
const APP_SHELL = [
  './',
  './index.html'
];

// Paths that must always go to the network — live data and auth endpoints.
const NEVER_CACHE = ['/kv', '/claude', '/weather', '/strava-token'];

// Cross-origin hosts that must NEVER be cached. API responses are live data —
// caching them serves stale activity lists and silently hides new activities.
const NEVER_CACHE_HOSTS = ['strava.com', 'www.strava.com', 'api.anthropic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      // Activate immediately rather than waiting for all tabs to close
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[sw] precache failed', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // Only handle GET — never interfere with POSTs (all our API calls are POST)
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Live endpoints: always network, never cached.
  if (NEVER_CACHE.some(p => url.pathname.startsWith(p))) return;

  // Cross-origin: ONLY cache static assets (fonts, CDN libraries). API hosts are
  // live data — caching them was serving stale Strava activity lists.
  if (url.origin !== self.location.origin) {
    if (NEVER_CACHE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
      return; // straight to network, never cached
    }
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        // Only cache successful, complete responses
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Navigation requests (the app itself): stale-while-revalidate.
  // Serve the cached shell instantly, refresh it in the background.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('index.html')) {
    event.respondWith(
      caches.match('./index.html').then(cached => {
        const network = fetch(req).then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        }).catch(() => null);
        // Cached first if we have it; otherwise wait for network
        return cached || network.then(r => r || new Response(
          '<h1>Offline</h1><p>BRB Training needs one online visit before it can work offline.</p>',
          { headers: { 'Content-Type': 'text/html' } }
        ));
      })
    );
    return;
  }

  // Other same-origin GETs (icons etc): cache-first with network fallback.
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit))
  );
});

// Allow the page to tell us to activate a waiting worker immediately
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
