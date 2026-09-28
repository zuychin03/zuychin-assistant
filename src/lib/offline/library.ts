import type { CaptureSource } from "@/lib/capture/types";
export interface OfflineDocument {
    profileId: string; documentId: string; path: string; markdown: string; commitSha: string; contentHash: string;
    downloadedAt: string; originalCaptureId: string | null; originalPdf?: Blob;
}
export interface QueuedNote { id: string; source: CaptureSource; createdAt: string }
export interface OfflineToken { profileId: string; epoch: string }
export interface OfflineState {
    version: 1; profileId: string | null; epoch: string; enabled: boolean;
    documents: OfflineDocument[]; queue: QueuedNote[]; lastSync: string | null;
}
export const emptyOfflineState = (): OfflineState => ({ version: 1, profileId: null, epoch: crypto.randomUUID(), enabled: false, documents: [], queue: [], lastSync: null });
export interface OfflineStorage {
    read(): Promise<OfflineState>;
    update<T>(change: (state: OfflineState) => T): Promise<T>;
}
const MAX_BYTES = 20 * 1024 * 1024;
function assertAccount(state: OfflineState, token: OfflineToken, enabled = true) {
    if (state.profileId !== token.profileId || state.epoch !== token.epoch) throw new Error("The account changed. Reopen the offline library.");
    if (enabled && !state.enabled) throw new Error("Enable offline storage before saving private content on this device.");
}
function checkSize(state: OfflineState) {
    const bytes = new TextEncoder().encode(JSON.stringify(state)).length + state.documents.reduce((sum, doc) => sum + (doc.originalPdf?.size ?? 0), 0);
    if (bytes > MAX_BYTES || state.documents.length > 50 || state.queue.length > 200) throw new Error("Offline storage is full. Remove a download or synchronise notes first.");
}
export function createOfflineLibrary(storage: OfflineStorage) {
    return {
        read: () => storage.read(),
        bindProfile: (profileId: string, expectedEpoch: string) => storage.update((state) => {
            if (!profileId) throw new Error("An authenticated profile is required.");
            if (state.epoch !== expectedEpoch) throw new Error("The account changed while loading. Reopen the offline library.");
            if (state.profileId !== profileId) Object.assign(state, emptyOfflineState(), { profileId });
            return { profileId, epoch: state.epoch };
        }),
        enable: (token: OfflineToken) => storage.update((state) => { assertAccount(state, token, false); state.enabled = true; }),
        clear: (expectedEpoch?: string) => storage.update((state) => {
            if (expectedEpoch && state.epoch !== expectedEpoch) throw new Error("The account changed while clearing. Reopen the offline library.");
            Object.assign(state, emptyOfflineState());
        }),
        download: (token: OfflineToken, document: OfflineDocument) => storage.update((state) => {
            assertAccount(state, token);
            if (document.profileId !== token.profileId) throw new Error("The document belongs to a different account.");
            if (!document.documentId || !document.path || typeof document.markdown !== "string" || !/^[a-f0-9]{40}$/.test(document.commitSha) || !/^[a-f0-9]{64}$/.test(document.contentHash)) throw new Error("The downloaded source is invalid.");
            if (document.markdown.length > 1_000_000 || (document.originalPdf?.size ?? 0) > 2 * 1024 * 1024) throw new Error("This source is too large for offline storage.");
            state.documents = [...state.documents.filter((entry) => entry.documentId !== document.documentId), document];
            checkSize(state);
        }),
        remove: (token: OfflineToken, documentId: string) => storage.update((state) => {
            assertAccount(state, token); state.documents = state.documents.filter((entry) => entry.documentId !== documentId);
        }),
        queueNote: (token: OfflineToken, documentId: string, text: string) => storage.update((state) => {
            assertAccount(state, token);
            if (!text.trim() || text.length > 20_000) throw new Error("Write a note of at most 20,000 characters.");
            const document = state.documents.find(entry => entry.documentId === documentId);
            if (!document) throw new Error("Download the source before adding an offline note.");
            const entry: QueuedNote = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), source: {
                kind: "offline_note", title: `Note: ${document.path}`.slice(0, 200), text,
                source: { documentId, path: document.path, commitSha: document.commitSha, contentHash: document.contentHash },
            } };
            state.queue.push(entry); checkSize(state); return entry;
        }),
        async sync(token: OfflineToken, send: (entry: QueuedNote) => Promise<{ id: string }>) {
            const before = await storage.read(); assertAccount(before, token);
            let synced = 0;
            for (const entry of before.queue) {
                assertAccount(await storage.read(), token);
                const receipt = await send(entry);
                if (receipt.id !== entry.id) throw new Error("The note was not confirmed. It remains queued for retry.");
                await storage.update((state) => {
                    assertAccount(state, token);
                    state.queue = state.queue.filter(note => note.id !== entry.id);
                    state.lastSync = new Date().toISOString();
                });
                synced++;
            }
            return synced;
        },
    };
}
