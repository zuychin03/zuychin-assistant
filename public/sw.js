// Push-only service worker: no offline caching (v1).

self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = { body: event.data ? event.data.text() : "" };
    }
    // Skip the notification when the app is focused — the reply is already on
    // screen; buzzing the same device is noise.
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
            const focused = list.some((c) => c.focused || c.visibilityState === "visible");
            if (focused) return undefined;
            return self.registration.showNotification(data.title || "Zuychin", {
                body: data.body || "",
                icon: "/icons/icon-192.png",
                badge: "/icons/icon-192.png",
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
