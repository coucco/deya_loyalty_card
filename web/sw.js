// Минимальный service worker: делает приложение устанавливаемым и открывает оболочку без сети.
// API-запросы НЕ кэшируются (баланс должен быть актуальным).
const CACHE = 'deya-shell-v2';
const SHELL = ['/', '/app.css', '/app.js', '/lib.js', '/qr.js', '/barcode.js', '/assets/logo.png', '/assets/cinema.jpg', '/assets/bowling.jpg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match('/'))));
});
