// ホーム画面アプリ（4.5）の Service Worker。
// - 画面の更新を公開したら、次に開いたときに新しい版に切り替わる（PW-05）
// - 電波がないときは、保存してある画面を出し、画面側で「オフラインです」と案内する（PW-04）
// - API の応答は保存しない（予約・回数は常にサーバーの最新を見る）

const VERSION = '__BUILD_VERSION__';
const CACHE = `hanamaru-student-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // 画面はネットワークを優先し、つながらなければ保存した画面を出す
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  // ファイル名にハッシュが付いた JS・CSS は、一度取れば変わらない
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && url.pathname.startsWith('/assets/')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
