"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, CheckCircle2, LoaderCircle, Smartphone } from "lucide-react";

type NotificationState = "checking" | "enabled" | "disabled" | "unconfirmed" | "unknown" | "blocked" | "unsupported" | "unconfigured";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
}

export default function NotificationsPanel() {
    const [state, setState] = useState<NotificationState>("checking");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const statusVersion = useRef(0);
    const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

    const checkStatus = useCallback(async () => {
        const version = ++statusVersion.current;
        const publish = (next: NotificationState) => { if (version === statusVersion.current) setState(next); };
        setState("checking");
        if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
            publish("unsupported");
            return;
        }
        if (!vapidPublicKey) {
            publish("unconfigured");
            return;
        }
        if (Notification.permission === "denied") {
            publish("blocked");
            return;
        }

        try {
            const registration = await navigator.serviceWorker.register("/sw.js");
            const subscription = await registration.pushManager.getSubscription();
            if (!subscription) { publish("disabled"); return; }
            const response = await fetch("/api/push/subscribe", { cache: "no-store", headers: { "X-Push-Endpoint": subscription.endpoint } });
            if (!response.ok) throw new Error("Could not verify alert registration.");
            const data = await response.json() as { registered?: boolean };
            if (typeof data.registered !== "boolean") throw new Error("Invalid alert status.");
            publish(data.registered ? "enabled" : "unconfirmed");
        } catch {
            publish("unknown");
        }
    }, [vapidPublicKey]);

    useEffect(() => { void checkStatus(); return () => { statusVersion.current += 1; }; }, [checkStatus]);

    const changeSubscription = async () => {
        if (busy || !["enabled", "disabled", "unconfirmed"].includes(state)) return;

        statusVersion.current += 1;
        setBusy(true);
        setMessage("");
        let pendingSubscription: PushSubscription | null = null;
        try {
            const registration = await navigator.serviceWorker.ready;
            const currentSubscription = await registration.pushManager.getSubscription();

            if (currentSubscription && state === "enabled") {
                const response = await fetch("/api/push/subscribe", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ endpoint: currentSubscription.endpoint }),
                });
                if (!response.ok) throw new Error("Could not remove the subscription.");
                pendingSubscription = currentSubscription;
                if (!await currentSubscription.unsubscribe()) throw new Error("Could not remove the browser subscription.");
                pendingSubscription = null;
                setState("disabled");
                setMessage("Browser alerts are turned off for this device.");
                return;
            }

            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
                setState(permission === "denied" ? "blocked" : "disabled");
                setMessage(permission === "denied" ? "Notifications are blocked in this browser." : "Permission was not granted.");
                return;
            }

            const subscription = currentSubscription ?? await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey!),
            });
            pendingSubscription = subscription;
            const response = await fetch("/api/push/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(subscription),
            });
            if (!response.ok) throw new Error("Could not save the subscription.");
            setState("enabled");
            setMessage("Browser alerts are on for this device.");
        } catch {
            setMessage("Could not update browser alerts. Please try again.");
            if (pendingSubscription) {
                const removed = await pendingSubscription.unsubscribe().catch(() => false);
                setState(removed ? "disabled" : "unconfirmed");
            } else await checkStatus();
        } finally {
            setBusy(false);
        }
    };

    const status = state === "enabled"
        ? { label: "Enabled", detail: "This browser can receive reminders and nudges.", tone: "success" }
        : state === "unknown"
            ? { label: "Status unavailable", detail: "Could not confirm browser alerts. Retry the status check.", tone: "warning" }
        : state === "unconfirmed"
            ? { label: "Setup not confirmed", detail: "Browser alert delivery has not been confirmed. Retry setup.", tone: "warning" }
        : state === "blocked"
            ? { label: "Blocked", detail: "Allow notifications in your browser settings to enable them.", tone: "warning" }
            : state === "unsupported"
                ? { label: "Unavailable", detail: "This browser does not support push notifications.", tone: undefined }
                : state === "unconfigured"
                    ? { label: "Setup required", detail: "Add the VAPID public key to enable browser alerts.", tone: "warning" }
                    : state === "checking"
                        ? { label: "Checking", detail: "Checking this browser's notification access.", tone: undefined }
                        : { label: "Off", detail: "Turn on browser alerts for reminders and nudges.", tone: undefined };
    const canChange = state === "enabled" || state === "disabled" || state === "unconfirmed" || state === "unknown";

    return (
        <div>
            <div className="panel-head">
                <Bell size={16} />
                <div className="panel-heading">
                    <h2>Browser alerts</h2>
                    <p>Manage notifications for this browser and device.</p>
                </div>
            </div>

            <div className="box" style={styles.status}>
                <span className="tone" data-tone={status.tone} style={styles.statusIcon}>
                    {state === "enabled" ? <CheckCircle2 size={18} /> : state === "checking" ? <LoaderCircle size={18} className="animate-spin" /> : <Smartphone size={18} />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.statusLine}><span className="dot" data-tone={status.tone} />{status.label}</div>
                    <div className="meta" style={{ marginTop: 2 }}>{status.detail}</div>
                </div>
            </div>

            <button
                type="button"
                className="btn"
                onClick={() => { if (state === "unknown") void checkStatus(); else void changeSubscription(); }}
                disabled={!canChange || busy}
                style={styles.action}
            >
                {busy ? <LoaderCircle size={14} className="animate-spin" /> : state === "enabled" ? <BellOff size={14} /> : <Bell size={14} />}
                {busy ? "Updating..." : state === "enabled" ? "Turn off alerts" : state === "unconfirmed" ? "Retry setup" : state === "unknown" ? "Retry status" : "Enable alerts"}
            </button>
            {message && <p role="status" className="meta" style={styles.message}>{message}</p>}
            <p className="meta" style={styles.message}>Notifications are set separately for each browser and device.</p>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    status: { display: "flex", gap: 10, alignItems: "center" },
    statusIcon: { display: "grid", placeItems: "center", flexShrink: 0, width: 28, height: 28 },
    statusLine: { display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 600 },
    action: { width: "100%", marginTop: 12 },
    message: { marginTop: 10 },
};
