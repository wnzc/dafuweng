/* ============================================================
   大富翁 · 地产小镇 — Service Worker
   ------------------------------------------------------------
   游戏是纯前端零依赖的：下面这些文件合计约 483 KB（代码 + 样式 + HTML 约
   189 KB，四个图标约 294 KB），也没有任何接口请求，
   所以整站塞进 Cache Storage 就能完全离线可玩。

   更新策略（刻意不做版本号常量，避免忘记手动 +1 导致用户卡在旧版）：
     · 页面导航   → 先联网，失败则用缓存里的 index.html（在线时永远最新）
     · 静态资源   → 先给缓存（秒开），同时后台拉新版写回缓存（下次访问即新）
   Service Worker 文件本身由浏览器按字节比对，改动后最多两次访问内生效。
   重新加载整个页面（不要强制刷新）就能拿到新版，不会打断正在进行的对局。
   ============================================================ */

const CACHE = 'dafuweng-v1';

/* 需要离线可用的文件。路径相对本文件，因此在
   https://wnzc.github.io/dafuweng/ 和本地任意子目录下都能用。 */
const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './js/data.js',
  './js/audio.js',
  './js/engine.js',
  './js/ui.js',
  './js/main.js',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个 add 而不是 addAll：少一个文件不至于让整次安装失败
    await Promise.all(PRECACHE.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 站外资源不插手

  // 页面导航：联网优先，离线时回落到缓存的应用外壳
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        return (await caches.match('./index.html')) || (await caches.match('./')) ||
          new Response('离线，且本地没有缓存的应用外壳。', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
      }
    })());
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  // 注意 waitUntil 必须在事件分发期间同步调用，否则后台那次 fetch
  // 可能在写回缓存之前就被浏览器收掉。
  const cachePromise = caches.open(CACHE);
  const netPromise = fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') {
      cachePromise.then((c) => c.put(req, res.clone())).catch(() => {});
    }
    return res;
  }).catch(() => null);
  event.waitUntil(netPromise);

  event.respondWith((async () => {
    const hit = await (await cachePromise).match(req, { ignoreSearch: true });
    return hit || (await netPromise) || new Response('', { status: 504 });
  })());
});
