// Service Worker – حسنة (offline support)
// غيّر رقم الإصدار عند كل تحديث للتطبيق حتى يصل التحديث للمستخدمين
const VERSION = 'hasana-v18';
const PAGES = VERSION + '-pages';
const ASSETS = VERSION + '-assets';

// رابط الخطوط كما هو في index.html تمامًا (إن غيّرت الخطوط هناك غيّره هنا أيضًا)
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Alexandria:wght@400;500;600&family=IBM+Plex+Sans+Arabic:wght@400;500&family=Amiri+Quran&display=swap';

// تحميل الخطوط مسبقًا عند التثبيت حتى تعمل بدون إنترنت من أول زيارة
// (محاولة اختيارية: إن فشلت لا يفشل التثبيت، وتُخزَّن الخطوط لاحقًا تلقائيًا)
async function precacheFonts() {
  const cache = await caches.open(ASSETS);
  const res = await fetch(FONTS_CSS);
  if (!res.ok) return;
  const css = await res.clone().text();
  await cache.put(FONTS_CSS, res);
  const files = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g) || [])];
  await Promise.all(files.map((u) =>
    fetch(u).then((r) => (r.ok ? cache.put(u, r) : null)).catch(() => {})
  ));
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // الصفحة الرئيسية ضرورية: إن فشلت لا يكتمل التثبيت
    const pages = await caches.open(PAGES);
    await pages.addAll([new Request('/', { cache: 'reload' })]);
    try { await precacheFonts(); } catch (err) { /* اختياري */ }
    await self.skipWaiting();
  })());
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
  if (url.pathname.startsWith('/_vercel/') || url.pathname.startsWith('/api/')) return; // الإحصائيات والـ API: لا تُخزَّن

  // الصفحة: الشبكة أولاً (لتصل التحديثات)، وعند انقطاع الإنترنت من الكاش
  // أي مسار (/ أو /index.html ...) يفتح الصفحة المخزنة عند عدم وجود اتصال
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // لا نخزّن إلا الردود السليمة، حتى لا تُستبدل الصفحة المخزنة بصفحة خطأ
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put('/', copy));
          }
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
          e.waitUntil(net.catch(() => {})); // يكمل التحديث في الخلفية حتى بعد الرد
          return cached || net;
        })
      )
    );
  }
});
