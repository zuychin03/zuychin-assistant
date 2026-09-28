import assert from "node:assert/strict";
import { createOfflineLibrary, emptyOfflineState, type OfflineState } from "../src/lib/offline/library";

let state = emptyOfflineState(), quota = false;
const library = createOfflineLibrary({
    read: async () => structuredClone(state),
    update: async (change) => {
        const candidate = structuredClone(state); const result = change(candidate);
        if (quota) throw new DOMException("Quota reached", "QuotaExceededError");
        state = candidate; return result;
    },
});
const token = await library.bindProfile("profile-a", state.epoch);
const document = { documentId: "doc-1", profileId: "profile-a", path: "notes/a.md", markdown: "# Offline\nPrivate content", commitSha: "a".repeat(40), contentHash: "b".repeat(64), downloadedAt: "2026-09-28T00:00:00Z", originalCaptureId: null };
await assert.rejects(library.download(token, document), /enable/i);
await library.enable(token);
await library.download(token, document);
assert.equal((await library.read()).documents.length, 1);
quota = true;
await assert.rejects(library.download(token, { ...document, markdown: "Changed" }));
assert.equal((await library.read()).documents[0].markdown, document.markdown);
quota = false;
const note = await library.queueNote(token, "doc-1", "An offline annotation.");
assert.equal((await library.read()).queue[0].id, note.id);
let deliveries = 0;
const received = new Set<string>();
await assert.rejects(library.sync(token, async (entry) => { received.add(entry.id); deliveries++; throw new Error("lost response"); }));
assert.equal((await library.read()).queue.length, 1);
await library.sync(token, async (entry) => { received.add(entry.id); deliveries++; return { id: entry.id }; });
assert.equal(received.size, 1); assert.equal(deliveries, 2); assert.equal((await library.read()).queue.length, 0);
await library.bindProfile("profile-b", state.epoch);
await assert.rejects(library.clear(token.epoch), /account changed/i);
assert.equal((await library.read()).profileId, "profile-b");
assert.equal((await library.read()).documents.length, 0); assert.equal((await library.read()).enabled, false);
await assert.rejects(library.download(token, document), /account/i);
await library.clear();
assert.equal((await library.read()).profileId, null);
await assert.rejects(library.bindProfile("profile-a", token.epoch), /account changed/i);
await assert.rejects(library.queueNote(token, "doc-1", "stale"), /account/i);
const latest = await library.bindProfile("profile-a", state.epoch); await library.enable(latest);
await assert.rejects(library.download(latest, { ...document, markdown: "x".repeat(1_000_001) }), /large/i);
assert.equal((state as OfflineState).documents.length, 0);
await library.download(latest, document);
await library.queueNote(latest, "doc-1", "An in-flight note");
let release: (() => void) | undefined;
const pendingSync = library.sync(latest, async entry => { await new Promise<void>(resolve => { release = resolve; }); return { id: entry.id }; });
while (!release) await new Promise(resolve => setTimeout(resolve, 0));
await library.clear(); release();
await assert.rejects(pendingSync, /account/i);
assert.equal((await library.read()).queue.length, 0); assert.equal((await library.read()).documents.length, 0);
console.log("Offline library: explicit opt-in, atomic quota failure, stable replay, account fencing and logout purge passed.");
