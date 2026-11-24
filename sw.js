const APP_CACHE = "pt-exam-app-v1";
const DATA_CACHE = "pt-exam-data-v1";

const APP_SHELL = [
  "./",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./data/manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([APP_CACHE, DATA_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isDataAsset(pathname) {
  return pathname.includes("/data/chunks/") || pathname.includes("/img/");
}

function getCleanAppCacheKey(req, url) {
  if (url.pathname.endsWith("/data/manifest.json")) {
    return `${url.origin}${url.pathname}`;
  }
  return req;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;

  if (isDataAsset(url.pathname)) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const resp = await fetch(req);
        if (resp && resp.ok) {
          cache.put(req, resp.clone());
        }
        return resp;
      })
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const resp = await fetch(req);
        if (resp && resp.ok) {
          cache.put(getCleanAppCacheKey(req, url), resp.clone());
        }
        return resp;
      } catch (err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === "navigate") {
          const shell = (await cache.match("./")) || (await cache.match("./index.html"));
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
