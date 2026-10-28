// アプリ本体だけをキャッシュする Service Worker（PDF や Google の通信は対象外）
const CACHE = 'drive-pdf-reader-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // HTML は常にネットワーク優先（更新を反映）、その他は古いものを返しつつ裏で更新
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(req, c)); return r; })
      .catch(() => caches.match(req).then((r) => r || caches.match('./'))));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((r) => {
        if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(req, c)); }
        return r;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});
