// Service worker — app-shell caching so SkyShear opens instantly and works as
// an installable PWA (required for the Google Play TWA wrapper).
// Strategy: stale-while-revalidate for same-origin shell files; the weather API
// is NEVER cached here — weather.js owns freshness and its own last-good cache.

const CACHE = 'skyshear-v15';
const SHELL = [
  './',
  './index.html',
  './flight.html',
  './forecast.html',
  './forecastapp.js',
  './icons.js',
  './styles.css',
  './app.js',
  './geometry.js',
  './turbulence.js',
  './weather.js',
  './sensors.js',
  './route.js',
  './flightcast.js',
  './profilechart.js',
  './globe.js',
  './schedules.js',
  './flightapp.js',
  './data/airports.json',
  './data/land.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return; // Open-Meteo + fonts go straight to network

  e.respondWith(
    caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached); // offline → whatever we have
      return cached || fresh;
    })
  );
});
