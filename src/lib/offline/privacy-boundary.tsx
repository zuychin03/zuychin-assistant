"use client";
import { useEffect } from "react";
import { clearStudyPending } from "../study/pending-review";
import { clearOfflinePrivateData, offlineLibrary, OFFLINE_PRIVACY_EVENT, notifyOfflinePrivacyChange } from "./storage";
export function OfflinePrivacyBoundary() {
    useEffect(() => {
        let revision = 0;
        const invalidated = () => { revision++; try { clearStudyPending(sessionStorage); } catch { /* Storage may be unavailable. */ } };
        const verify = async () => {
            const current = ++revision;
            try {
                const before = await offlineLibrary.read();
                if (current !== revision) return;
                const response = await fetch("/api/capture/session", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
                if (current !== revision) return;
                if (response.status === 401 || (response.redirected && new URL(response.url).pathname === "/login")) { await clearOfflinePrivateData(before.epoch); return; }
                if (!response.ok) return;
                const data = await response.json();
                if (current !== revision || typeof data.profileId !== "string") return;
                await offlineLibrary.bindProfile(data.profileId, before.epoch);
                if (before.profileId && before.profileId !== data.profileId) notifyOfflinePrivacyChange();
            } catch { /* Offline copies remain available while disconnected. */ }
        };
        void verify();
        window.addEventListener("focus", verify); window.addEventListener("online", verify);
        window.addEventListener(OFFLINE_PRIVACY_EVENT, invalidated);
        const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(OFFLINE_PRIVACY_EVENT) : null;
        if (channel) channel.onmessage = invalidated;
        return () => { revision++; window.removeEventListener("focus", verify); window.removeEventListener("online", verify); window.removeEventListener(OFFLINE_PRIVACY_EVENT, invalidated); channel?.close(); };
    }, []);
    return null;
}
