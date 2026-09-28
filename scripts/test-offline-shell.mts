import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const listeners = new Map<string, (event: unknown) => void>(), saved: string[] = [], deleted: string[] = [];
let offline = false;
const context = {
    self: { location: { origin: "https://fixture.invalid" }, addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn), skipWaiting: async () => undefined, clients: { claim: async () => undefined } },
    caches: {
        open: async () => ({ addAll: async (paths: string[]) => { saved.push(...paths); } }),
        keys: async () => ["unrelated", "zuychin-offline-shell-v0", "zuychin-offline-shell-v1", "zuychin-offline-shell-v2"],
        delete: async (key: string) => { deleted.push(key); return true; },
        match: async (path: string) => new Response(`STATIC ${path}`),
    },
    fetch: async () => { if (offline) throw new Error("Disconnected"); return new Response("LIVE"); }, URL,
};
vm.runInNewContext(await readFile(new URL("../public/sw.js", import.meta.url), "utf8"), context);
let pending: Promise<unknown> | undefined;
listeners.get("install")!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } }); await pending;
assert.deepEqual(saved, ["/offline.html", "/offline-reader.js", "/offline-reader.css"]);
listeners.get("activate")!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } }); await pending;
assert.deepEqual(deleted, ["zuychin-offline-shell-v0", "zuychin-offline-shell-v1"]);
function intercepted(path: string, mode = "cors", method = "GET") {
    let response: Promise<Response> | undefined;
    listeners.get("fetch")!({ request: { url: `https://fixture.invalid${path}`, method, mode }, respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
}
for (const path of ["/api/chat", "/api/knowledge/documents", "/api/capture", "/api/capture/original?id=private", "/admin", "/"]) assert.equal(intercepted(path, "navigate"), undefined);
assert.equal(intercepted("/capture", "navigate", "POST"), undefined);
offline = true;
assert.equal(await (await intercepted("/capture", "navigate"))!.text(), "STATIC /offline.html");
assert.equal(await (await intercepted("/offline-reader.js"))!.text(), "STATIC /offline-reader.js");
console.log("Offline service worker: only public shell cached; private routes bypass cache; navigation fallback verified.");
