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
        ? { label: "Enabled", detail: "This browser can receive reminders and nudges.", color: "var(--admin-success)" }
        : state === "unknown"
            ? { label: "Status unavailable", detail: "Could not confirm browser alerts. Retry the status check.", color: "var(--admin-warning)" }
        : state === "unconfirmed"
            ? { label: "Setup not confirmed", detail: "Browser alert delivery has not been confirmed. Retry setup.", color: "var(--admin-warning)" }
        : state === "blocked"
            ? { label: "Blocked", detail: "Allow notifications in your browser settings to enable them.", color: "var(--admin-warning)" }
            : state === "unsupported"
                ? { label: "Unavailable", detail: "This browser does not support push notifications.", color: "#8f96a3" }
                : state === "unconfigured"
                    ? { label: "Setup required", detail: "Add the VAPID public key to enable browser alerts.", color: "var(--admin-warning)" }
                    : state === "checking"
                        ? { label: "Checking", detail: "Checking this browser's notification access.", color: "var(--admin-info)" }
                        : { label: "Off", detail: "Turn on browser alerts for reminders and nudges.", color: "#8f96a3" };
    const canChange = state === "enabled" || state === "disabled" || state === "unconfirmed" || state === "unknown";

    return (
        <div>
            <div style={styles.header}>
                <div style={styles.headerIcon}><Bell size={16} /></div>
                <div>
                    <h2 style={styles.title}>Browser alerts</h2>
                    <p style={styles.description}>Manage notifications for this browser and device.</p>
                </div>
            </div>

            <div style={styles.statusCard}>
                <div style={{ ...styles.statusIcon, color: status.color }}>
                    {state === "enabled" ? <CheckCircle2 size={18} /> : state === "checking" ? <LoaderCircle size={18} className="animate-spin" /> : <Smartphone size={18} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.statusLine}><span style={{ ...styles.dot, background: status.color }} />{status.label}</div>
                    <div style={styles.statusDetail}>{status.detail}</div>
                </div>
            </div>

            <button
                type="button"
                onClick={() => { if (state === "unknown") void checkStatus(); else void changeSubscription(); }}
                disabled={!canChange || busy}
                style={{ ...styles.action, ...(!canChange || busy ? styles.actionDisabled : {}) }}
            >
                {busy ? <LoaderCircle size={14} className="animate-spin" /> : state === "enabled" ? <BellOff size={14} /> : <Bell size={14} />}
                {busy ? "Updating..." : state === "enabled" ? "Turn off alerts" : state === "unconfirmed" ? "Retry setup" : state === "unknown" ? "Retry status" : "Enable alerts"}
            </button>
            {message && <p role="status" style={styles.message}>{message}</p>}
            <p style={styles.note}>Notifications are set separately for each browser and device.</p>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    header: { display: "flex", gap: 11, alignItems: "flex-start", marginBottom: 14 },
    headerIcon: {
        width: 32, height: 32, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
        background: "color-mix(in srgb, var(--color-background) 58%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 58%, transparent)", flexShrink: 0,
    },
    title: { fontSize: 15, fontWeight: 800, letterSpacing: "-0.02em", margin: 0 },
    description: { margin: "3px 0 0", fontSize: 12, color: "var(--color-text-muted)" },
    statusCard: {
        display: "flex", gap: 10, alignItems: "center", padding: "11px 12px", borderRadius: 16,
        background: "color-mix(in srgb, var(--color-background) 48%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-border) 48%, transparent)",
    },
    statusIcon: { width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    statusLine: { display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 700 },
    dot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
    statusDetail: { marginTop: 3, fontSize: 11.5, lineHeight: 1.4, color: "var(--color-text-muted)" },
    action: {
        width: "100%", marginTop: 10, minHeight: 36, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
        border: "1px solid color-mix(in srgb, var(--color-primary) 45%, var(--color-border))", borderRadius: 11,
        background: "color-mix(in srgb, var(--color-primary) 11%, var(--color-surface))", color: "var(--color-text-primary)",
        font: "inherit", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
    },
    actionDisabled: { opacity: 0.55, cursor: "not-allowed" },
    message: { margin: "9px 1px 0", fontSize: 11.5, lineHeight: 1.4, color: "var(--color-text-muted)" },
    note: { margin: "9px 1px 0", fontSize: 11, lineHeight: 1.4, color: "var(--color-text-muted)" },
};
