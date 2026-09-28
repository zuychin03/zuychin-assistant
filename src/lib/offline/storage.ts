import { createOfflineLibrary, emptyOfflineState, type OfflineState, type OfflineStorage } from "./library";
import { clearStudyPending } from "../study/pending-review";
const DATABASE = "zuychin-offline-library";
let opened: Promise<IDBDatabase> | undefined;
async function open() {
    if (!opened) opened = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("library").put(emptyOfflineState(), "state");
        request.onsuccess = () => {
            request.result.onversionchange = () => { request.result.close(); opened = undefined; };
            resolve(request.result);
        };
        request.onerror = () => reject(request.error ?? new Error("Offline storage is unavailable."));
        request.onblocked = () => reject(new Error("Close another offline reader tab and retry."));
    }).catch(error => { opened = undefined; throw error; });
    return opened;
}
export const browserOfflineStorage: OfflineStorage = {
    async read() {
        const database = await open();
        return new Promise<OfflineState>((resolve, reject) => {
            const transaction = database.transaction("library", "readonly");
            const request = transaction.objectStore("library").get("state");
            request.onsuccess = () => resolve(request.result ?? emptyOfflineState());
            request.onerror = () => reject(request.error);
        });
    },
    async update<T>(change: (state: OfflineState) => T): Promise<T> {
        const database = await open();
        return new Promise<T>((resolve, reject) => {
            const transaction = database.transaction("library", "readwrite");
            const store = transaction.objectStore("library"), request = store.get("state");
            let value: T, failure: unknown;
            request.onsuccess = () => {
                try { const state = request.result ?? emptyOfflineState(); value = change(state); store.put(state, "state"); }
                catch (error) { failure = error; transaction.abort(); }
            };
            transaction.oncomplete = () => resolve(value);
            transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Offline storage is full or unavailable. Your existing downloads are unchanged."));
            transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("The offline update was interrupted. Retry without removing your draft."));
        });
    },
};
export const offlineLibrary = createOfflineLibrary(browserOfflineStorage);
export const OFFLINE_PRIVACY_EVENT = "zuychin-offline-privacy";
export function notifyOfflinePrivacyChange() {
    try { clearStudyPending(sessionStorage); } catch { /* Storage may be unavailable. */ }
    window.dispatchEvent(new Event(OFFLINE_PRIVACY_EVENT));
    if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(OFFLINE_PRIVACY_EVENT); channel.postMessage("cleared"); channel.close();
    }
}
export async function clearOfflinePrivateData(expectedEpoch?: string) {
    notifyOfflinePrivacyChange();
    await offlineLibrary.clear(expectedEpoch);
}
export async function clearConfirmedOfflinePrivateData(expectedEpoch: string) {
    await offlineLibrary.clear(expectedEpoch);
    notifyOfflinePrivacyChange();
}
