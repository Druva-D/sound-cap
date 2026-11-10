// Offline shell: network-first for the app's own files, so updates land immediately.
// Spotify API calls are never cached here — the app keeps its own data in IndexedDB.
const CACHE = 'soundcap-v9';
const SHELL = [
  './', 'index.html', 'privacy.html', 'styles.css', 'manifest.webmanifest',
  'src/main.js', 'src/ui.js', 'src/auth.js', 'src/api.js', 'src/db.js', 'src/stats.js', 'src/config.js',
  'src/source-spotify.js', 'src/source-demo.js', 'src/importer.js', 'src/share.js', 'src/personas.js', 'src/analytics.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'fonts/figtree-latin.woff2', 'fonts/figtree-latin-ext.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('soundcap-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    return hit || (req.mode === 'navigate' && (await cache.match('index.html'))) || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === location.origin) e.respondWith(networkFirst(request));
});
