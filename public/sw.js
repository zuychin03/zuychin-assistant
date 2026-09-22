// Push-only updates can activate immediately because no page assets are cached.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));

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
