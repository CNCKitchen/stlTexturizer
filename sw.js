const CACHE_VERSION = 'bumpmesh-v2';

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './logo.png',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/main.js',
  './js/viewer.js',
  './js/stlLoader.js',
  './js/smartResolution.js',
  './js/presetTextures.js',
  './js/previewMaterial.js',
  './js/subdivision.js',
  './js/regularize.js',
  './js/exportPipeline.js',
  './js/exporter.js',
  './js/exclusion.js',
  './js/meshValidation.js',
  './js/i18n.js',
  './js/meshIndex.js',
  './js/mapping.js',
  './js/displacement.js',
  './js/decimation.js',
  './js/meshRepair.js',
  './js/textureAnalysis.js',
  './js/threeCompat.js',
  './js/exportWorker.js',
  './js/i18n/en.js',
  './js/i18n/de.js',
  './js/i18n/es.js',
  './js/i18n/fr.js',
  './js/i18n/it.js',
  './js/i18n/ja.js',
  './js/i18n/ko.js',
  './js/i18n/pt.js',
  './js/i18n/tr.js',
  './js/i18n/uk.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (url.hostname === 'cdn.jsdelivr.net') {
      event.respondWith(networkFirst(request));
    }
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw new Error('Network unavailable');
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || networkPromise || fetch(request);
}
