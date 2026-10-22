
const CACHE = "researchflow-v0.6.3";
const CORE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app-v0.6.3.js?v=0.6.3",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Never cache Microsoft authentication or Graph responses.
  if (url.hostname.includes("microsoftonline.com") || url.hostname.includes("graph.microsoft.com") || url.hostname.includes("live.com")) {
    return;
  }

  if (event.request.method !== "GET") return;

  const isCode =
    event.request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css");

  if (isCode) {
    event.respondWith(
      fetch(event.request, {cache:"no-store"}).then(response => {
        if (response && response.ok && url.origin === self.location.origin) {
          const clone=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,clone));
        }
        return response;
      }).catch(()=>caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(response => {
        if (response && response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
