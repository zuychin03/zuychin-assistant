const OFFLINE_CACHE = "zuychin-offline-shell-v2";
const OFFLINE_ASSETS = ["/offline.html", "/offline-reader.js", "/offline-reader.css"];
self.addEventListener("install", (event) => event.waitUntil(
    caches.open(OFFLINE_CACHE).then(cache => cache.addAll(OFFLINE_ASSETS)).then(() => self.skipWaiting())
));
self.addEventListener("activate", (event) => event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("zuychin-offline-shell-") && key !== OFFLINE_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
    if (OFFLINE_ASSETS.includes(url.pathname)) {
        event.respondWith(fetch(event.request).catch(() => caches.match(url.pathname)));
    } else if (event.request.mode === "navigate" && url.pathname === "/capture") {
        event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
    }
});

self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = { body: event.data ? event.data.text() : "" };
    }
    // Skip the notification when the app is focused - the reply is already on
    // screen; buzzing the same device is noise.
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
            const focused = list.some((c) => c.focused || c.visibilityState === "visible");
            if (focused) return undefined;
            return self.registration.showNotification(data.title || "Zuychin", {
                body: data.body || "",
                icon: "/icons/icon-192.png?v=b879353ceb1b",
                badge: "/icons/badge-72.png?v=b2f03a77318b",
                data: { url: data.url || "/" },
            });
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || "/";
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if ("focus" in client) {
                    client.navigate(url);
                    return client.focus();
                }
            }
            return clients.openWindow(url);
        })
    );
});
