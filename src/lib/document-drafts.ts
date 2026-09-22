export interface DocumentDraft { version: 1; path: string; base: string; text: string; updatedAt: number }
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PREFIX = "zuychin:document-draft:v1:";
const memory = new Map<string, DocumentDraft>();
const unpersisted = new Set<string>();
const listeners = new Set<() => void>();
let warningInstalled = false;

export function subscribeDocumentDrafts(listener: () => void): () => void {
    listeners.add(listener);
    if (typeof window !== "undefined") window.addEventListener("storage", listener);
    return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined") window.removeEventListener("storage", listener);
    };
}

export function documentDraftPersisted(path: string): boolean { return !unpersisted.has(path); }

function markPersistence(path: string, persisted: boolean): boolean {
    if (persisted) unpersisted.delete(path);
    else unpersisted.add(path);
    if (!warningInstalled && typeof window !== "undefined") {
        window.addEventListener("beforeunload", (event) => {
            if (!unpersisted.size) return;
            event.preventDefault(); event.returnValue = "";
        });
        warningInstalled = true;
    }
    listeners.forEach((listener) => listener());
    return persisted;
}

export function readDocumentDraft(path: string, storage?: DraftStorage): DocumentDraft | null {
    try {
        const value = storage?.getItem(PREFIX + path);
        if (value) {
            const draft = JSON.parse(value) as Partial<DocumentDraft>;
            if (draft.version === 1 && draft.path === path && typeof draft.base === "string"
                && typeof draft.text === "string" && typeof draft.updatedAt === "number") {
                const cached = memory.get(path);
                if (!cached || (!unpersisted.has(path) && draft.updatedAt > cached.updatedAt)) memory.set(path, draft as DocumentDraft);
            }
        }
    } catch { /* Keep the in-memory recovery copy. */ }
    return memory.get(path) ?? null;
}

export function writeDocumentDraft(path: string, base: string, text: string, storage?: DraftStorage): boolean {
    const draft: DocumentDraft = { version: 1, path, base, text, updatedAt: Math.max(Date.now(), (memory.get(path)?.updatedAt ?? 0) + 1) };
    memory.set(path, draft);
    if (text === base) return discardDocumentDraft(path, storage);
    try {
        if (!storage) return markPersistence(path, false);
        storage.setItem(PREFIX + path, JSON.stringify(draft));
        return markPersistence(path, true);
    } catch { return markPersistence(path, false); }
}

export function discardDocumentDraft(path: string, storage?: DraftStorage): boolean {
    if (!storage) return markPersistence(path, false);
    try { storage.removeItem(PREFIX + path); }
    catch { return markPersistence(path, false); }
    memory.delete(path);
    return markPersistence(path, true);
}

export function acknowledgeDocumentSave(path: string, submitted: string, saved: string, storage?: DraftStorage): boolean {
    const draft = readDocumentDraft(path, storage);
    if (!draft || draft.text === submitted) return discardDocumentDraft(path, storage);
    return writeDocumentDraft(path, saved, draft.text, storage);
}
