const CACHE_NAME = "store-scan-shell-v6";
// Cache the core Store Scan app shell so the counting workflow can open after a prior online visit.
// cache.addAll() fails as a group if any route is missing, so keep this list limited to real, core routes.
const SHELL_ASSETS = [
  "/",
  "/login",
  "/store-count",
  "/store-scan",
  "/store-products",
  "/store-locations",
  "/settings",
  "/offline",
];

// Cache only safe read-only item API responses. Never cache writes.
const API_CACHE_NAME = "store-scan-api-v2";
const ITEMS_API_SUBROUTE_DENYLIST = new Set(["scan", "stats", "export.csv", "import.csv", "bulk", "bulk-delete"]);

function isCacheableItemsGet(request) {
  if (request.method !== "GET") return false;
  const { pathname } = new URL(request.url);
  if (pathname === "/api/items") return true;
  const match = pathname.match(/^\/api\/items\/([^/]+)$/);
  return !!match && !ITEMS_API_SUBROUTE_DENYLIST.has(match[1]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  const keep = new Set([CACHE_NAME, API_CACHE_NAME]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CLEAR_USER_DATA") {
    event.waitUntil(caches.delete(API_CACHE_NAME));
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (isCacheableItemsGet(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(API_CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() =>
          caches.open(API_CACHE_NAME).then((cache) => cache.match(request)).then((cached) => cached || Response.error()),
        ),
    );
    return;
  }

  if (request.url.includes("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === "navigate") return caches.match("/offline");
          return Response.error();
        }),
      ),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Store Scan", body: "", url: "/store-count" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* malformed payload — show safe defaults */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon.svg",
      data: { url: data.url || "/store-count" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/store-count";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
