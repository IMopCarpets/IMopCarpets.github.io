/* ==========================================================================
   Punchline — service worker
   Cache-first for the app shell so the app opens instantly and works with no
   network at all. Bump CACHE_NAME whenever a shell file changes.
   ========================================================================== */

var CACHE_NAME = 'punchline-v1';

var SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // addAll is all-or-nothing; add individually so one 404 cannot break install.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { /* optional file */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE_NAME ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch third parties

  // Navigations: cache-first on the shell, falling back to the network, and to
  // index.html for any in-app URL so a bookmarked hash route still opens offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(function (cached) {
        return cached || fetch(req).catch(function () { return caches.match('./index.html'); });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        // Runtime-cache same-origin successes so nothing is ever fetched twice.
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return cached || Response.error();
      });
    })
  );
});

// Let the page ask for an immediate activation after an update.
self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
