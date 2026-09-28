import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createOfflineLibrary, emptyOfflineState, type OfflineState } from "../src/lib/offline/library";

const elements = new Map<string, { textContent: string; value: string; hidden: boolean; disabled: boolean; replaceChildren(): void; append(): void }>();
function element(id: string) {
    if (!elements.has(id)) elements.set(id, { textContent: "PRIVATE CONTENT", value: "PRIVATE NOTE", hidden: false, disabled: false, replaceChildren() { this.textContent = ""; }, append() {} });
    return elements.get(id)!;
}
let saved: OfflineState = { ...emptyOfflineState(), profileId: "a", enabled: true };
let writeFailure = false, broadcasts = 0;
type RequestStub = { result?: unknown; onsuccess?: () => void; onerror?: () => void };
const database = {
    transaction(_store: string, mode: string) {
        const transaction = { oncomplete: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined,
            abort() { queueMicrotask(() => transaction.onabort?.()); },
            objectStore() { return {
                get() { const request: RequestStub = {}; queueMicrotask(() => { request.result = structuredClone(saved); request.onsuccess?.(); }); return request; },
                put(value: OfflineState) { queueMicrotask(() => { if (writeFailure && mode === "readwrite") transaction.onerror?.(); else { saved = structuredClone(value); transaction.oncomplete?.(); } }); },
            }; },
        };
        return transaction;
    },
};
let fetchResponse: () => Promise<Response> = async () => new Response(null, { status: 401 });
const privateSession = new Map([ ["zuychin-study-pending-review:a", "private answer"] ]);
const session = { get length() { return privateSession.size; }, key: (index: number) => [...privateSession.keys()][index], removeItem: (key: string) => privateSession.delete(key) };
class Channel { onmessage?: () => void; postMessage() { broadcasts++; } close() {} }
const context = vm.createContext({ document: { documentElement: { dataset: {} }, getElementById: element, createElement: element }, window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    indexedDB: { open: () => ({}) }, fixtureDb: database, fetch: () => fetchResponse(), sessionStorage: session, BroadcastChannel: Channel,
    crypto, URL, AbortSignal, TextEncoder, console, setTimeout, clearTimeout });
vm.runInContext(await readFile(new URL("../public/offline-reader.js", import.meta.url), "utf8"), context);
vm.runInContext("database = fixtureDb", context);
const verify = () => vm.runInContext("verify()", context) as Promise<boolean>;
assert.equal(await verify(), false);
assert.equal(saved.profileId, null); assert.equal(element("content").textContent, ""); assert.equal(privateSession.size, 0); assert.equal(broadcasts, 1);
console.log("PASS standalone 401 hides content, clears private draft and broadcasts");

saved = { ...emptyOfflineState(), profileId: "a", enabled: true }; writeFailure = true;
element("content").textContent = "PRIVATE CONTENT";
assert.equal(await verify(), false);
assert.equal(saved.profileId, "a"); assert.equal(element("content").textContent, ""); assert.match(element("status").textContent, /cleanup was not confirmed/); assert.equal(broadcasts, 2);
console.log("PASS failed device cleanup keeps view hidden and reports failure");

writeFailure = false;
let release: ((response: Response) => void) | undefined;
fetchResponse = () => new Promise(resolve => { release = resolve; });
const pending = verify();
while (!release) await new Promise(resolve => setTimeout(resolve, 0));
saved = { ...emptyOfflineState(), profileId: "new-owner", enabled: true };
const newEpoch = saved.epoch;
release(Response.json({ profileId: "stale-owner" }));
assert.equal(await pending, false);
assert.equal(saved.profileId, "new-owner"); assert.equal(saved.epoch, newEpoch);
console.log("PASS stale session response cannot clear a newer persisted epoch");

const pendingSameProfile = verify(); release = undefined;
while (!release) await new Promise(resolve => setTimeout(resolve, 0));
saved = { ...emptyOfflineState(), profileId: "third-owner", enabled: true };
(release as (response: Response) => void)(Response.json({ profileId: "new-owner" }));
assert.equal(await pendingSameProfile, false);
assert.equal(saved.profileId, "third-owner");
console.log("PASS same-profile stale response cannot authorise displaying a newer account");

fetchResponse = async () => { throw new Error("Offline"); };
assert.equal(await verify(), true);
assert.equal(saved.profileId, "third-owner");
console.log("PASS ordinary disconnection preserves explicitly downloaded content");

const { clearConfirmedOfflinePrivateData, clearOfflinePrivateData, offlineLibrary } = await import("../src/lib/offline/storage");
const events: string[] = [];
Object.assign(globalThis, { window: { dispatchEvent: (event: Event) => { events.push(event.type); } }, sessionStorage: session, BroadcastChannel: Channel });
privateSession.set("zuychin-study-pending-review:a", "private");
const originalClear = offlineLibrary.clear;
offlineLibrary.clear = async () => { throw new Error("IndexedDB unavailable"); };
await assert.rejects(clearOfflinePrivateData(), /IndexedDB unavailable/);
assert.deepEqual(events, ["zuychin-offline-privacy"]); assert.equal(privateSession.size, 0);
offlineLibrary.clear = originalClear;
console.log("PASS shared cleanup invalidates mounted views before a failing IndexedDB clear");

let manualState: OfflineState = { ...emptyOfflineState(), profileId: "new-owner", enabled: true };
let manualStorageFailure = false;
const order: string[] = [];
const manualLibrary = createOfflineLibrary({
    read: async () => structuredClone(manualState),
    async update(change) {
        const next = structuredClone(manualState);
        const result = change(next);
        if (manualStorageFailure) throw new Error("IndexedDB unavailable");
        manualState = next;
        order.push("persisted");
        return result;
    },
});
offlineLibrary.clear = manualLibrary.clear;
events.length = 0;
privateSession.set("zuychin-study-pending-review:new-owner", "private");
const previousBroadcasts = broadcasts;
const currentEpoch = manualState.epoch;
Object.assign(globalThis, { window: { dispatchEvent: (event: Event) => { events.push(event.type); order.push("purged"); } } });
await assert.rejects(clearConfirmedOfflinePrivateData("stale-epoch"), /account changed/);
assert.equal(manualState.epoch, currentEpoch); assert.equal(manualState.enabled, true);
assert.equal(privateSession.size, 1); assert.deepEqual(events, []); assert.equal(broadcasts, previousBroadcasts); assert.deepEqual(order, []);
console.log("PASS stale manual confirmation preserves newer offline state and private drafts");

manualStorageFailure = true;
await assert.rejects(clearConfirmedOfflinePrivateData(currentEpoch), /IndexedDB unavailable/);
assert.equal(manualState.epoch, currentEpoch); assert.equal(manualState.enabled, true);
assert.equal(privateSession.size, 1); assert.deepEqual(events, []); assert.equal(broadcasts, previousBroadcasts); assert.deepEqual(order, []);
console.log("PASS failed manual storage clear leaves mounted drafts and pending Study intact");

manualStorageFailure = false;
await clearConfirmedOfflinePrivateData(currentEpoch);
assert.equal(manualState.profileId, null); assert.equal(manualState.enabled, false);
assert.equal(privateSession.size, 0); assert.deepEqual(events, ["zuychin-offline-privacy"]); assert.equal(broadcasts, previousBroadcasts + 1);
assert.deepEqual(order, ["persisted", "purged"]);
offlineLibrary.clear = originalClear;
console.log("PASS confirmed manual clear persists successfully before purging drafts across views");
console.log("Offline privacy: 9 production-path mocked checks passed.");
