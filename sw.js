// Service Worker – حسنة (offline support)
// غيّر رقم الإصدار عند كل تحديث للتطبيق حتى يصل التحديث للمستخدمين
const VERSION = 'hasana-v1';
const PAGES = VERSION + '-pages';
const ASSETS = VERSION + '-assets';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(PAGES).then((c) => c.addAll(['/'])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== PAGES && k !== ASSETS).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.pathname.startsWith('/_vercel/')) return; // الإحصائيات: لا تُخزَّن

  // الصفحة: الشبكة أولاً (لتصل التحديثات)، وعند انقطاع الإنترنت من الكاش
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(PAGES).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // الخطوط وبقية الملفات: من الكاش فوراً مع تحديثها في الخلفية
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (isFont || url.origin === location.origin) {
    e.respondWith(
      caches.open(ASSETS).then((cache) =>
        cache.match(req).then((cached) => {
          const net = fetch(req)
            .then((res) => {
              if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || net;
        })
      )
    );
  }
});
