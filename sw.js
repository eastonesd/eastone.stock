/*
 * 東石診股 - Service Worker
 * 策略：網路優先。有網路時永遠拿最新版（改完推上 GitHub 就生效，不會卡舊版），
 *       沒網路時才用上次的快取開啟 APP 外殼。
 * FinMind 的 API 請求不經過這裡（跨網域，直接放行），所以股價資料不會被快取成舊的。
 */
const CACHE = "eastone-stock-shell";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
  );
});
