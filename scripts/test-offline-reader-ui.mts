import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { emptyOfflineState, type OfflineState } from "../src/lib/offline/library";

class Element {
    textContent = "";
    value = "";
    hidden = false;
    disabled = false;
    children: Element[] = [];
    attributes = new Map<string, string>();
    onclick?: () => void | Promise<void>;
    oninput?: () => void;
    constructor(readonly tag: string) {}
    replaceChildren() { this.children = []; }
    append(...elements: Element[]) { this.children.push(...elements); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    focused = false;
    focus() { this.focused = true; }
    querySelectorAll(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
}
let allowDiscard = false;
const windowListeners = new Map<string, (event: unknown) => void>();
const elements = new Map<string, Element>();
function element(id: string) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id)!; }
const document = { documentId: "one", profileId: "owner", path: "notes/one.md", markdown: "Saved source", commitSha: "a".repeat(40), contentHash: "b".repeat(64), downloadedAt: "2026-09-28T00:00:00Z", originalCaptureId: null };
let saved: OfflineState = { ...emptyOfflineState(), profileId: "owner", enabled: true, documents: [document, { ...document, documentId: "two", path: "notes/two.md" }] };
let finishWrite: (() => void) | undefined;
let failWrite = false, failRead = false;
let storedTheme: string | null = "dark", systemDark = false, themeStorageUnavailable = false;
const root = { dataset: {} as { theme?: string } };
const themeListeners: Array<() => void> = [];
const media = { get matches() { return systemDark; }, addEventListener(_event: string, callback: () => void) { themeListeners.push(callback); } };
const database = {
    transaction() {
        const transaction = { oncomplete: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined,
            abort() { queueMicrotask(() => transaction.onabort?.()); },
            objectStore() { return {
                get() { const request = { result: undefined as OfflineState | undefined, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined, error: new Error("Synthetic read failure") }; queueMicrotask(() => { if (failRead) request.onerror?.(); else { request.result = structuredClone(saved); request.onsuccess?.(); } }); return request; },
                put(value: OfflineState) { finishWrite = () => { if (failWrite) transaction.onerror?.(); else { saved = structuredClone(value); transaction.oncomplete?.(); } }; },
            }; },
        };
        return transaction;
    },
};
const context = vm.createContext({ document: { documentElement: root, getElementById: element, createElement: (tag: string) => new Element(tag) }, window: { matchMedia: () => media, addEventListener: (name: string, callback: (event: unknown) => void) => windowListeners.set(name, callback), confirm: () => allowDiscard },
    localStorage: { getItem: () => { if (themeStorageUnavailable) throw new Error("Blocked"); return storedTheme; } }, indexedDB: { open: () => ({}) }, fixtureDb: database, crypto, URL, AbortSignal, TextEncoder, console });
vm.runInContext(await readFile(new URL("../public/offline-reader.js", import.meta.url), "utf8"), context);
vm.runInContext("database = fixtureDb", context);
await vm.runInContext("read()", context);
const buttons = element("documents").querySelectorAll("button");
await buttons[0].onclick!();
assert.equal(element("title").focused, true, "Opening a saved document focuses its heading");
assert.equal(buttons[0].attributes.get("aria-pressed"), "true");
assert.equal(element("queue").disabled, true, "An empty note cannot be queued");
element("note").value = "Keep this note";
element("note").oninput!();
assert.equal(element("queue").disabled, false);
const pending = element("queue").onclick!();
assert.equal(element("note").disabled, true, "Note editing is blocked while its snapshot is saving");
assert.ok(buttons.every(button => button.disabled), "Document switching is blocked while saving");
await buttons[1].onclick!();
assert.equal(element("title").textContent, "notes/one.md");
await Promise.resolve();
assert.ok(finishWrite);
finishWrite();
await pending;
assert.equal(saved.queue.length, 1);
assert.equal(saved.queue[0].source.text, "Keep this note");
assert.equal(element("note").value, "");
assert.equal(element("note").disabled, false);
assert.equal(element("queue").disabled, true);
assert.ok(element("documents").querySelectorAll("button").every(button => !button.disabled));
console.log("PASS offline reader focus, selection, pending editor lock and successful save reset");

element("note").value = "Retain this failed note";
element("note").oninput!();
failWrite = true;
const failed = element("queue").onclick!();
await Promise.resolve();
finishWrite!();
await failed;
assert.equal(saved.queue.length, 1);
assert.equal(element("note").value, "Retain this failed note");
assert.equal(element("note").disabled, false);
assert.equal(element("queue").disabled, false);
assert.match(element("status").textContent, /not been saved/);
console.log("PASS failed offline note write preserves text and re-enables safe retry");
const other = element("documents").querySelectorAll("button")[1];
await other.onclick!();
assert.equal(element("title").textContent, "notes/one.md");
assert.equal(element("note").value, "Retain this failed note");
allowDiscard = true;
await other.onclick!();
assert.equal(element("title").textContent, "notes/two.md");
assert.equal(element("note").value, "");
console.log("PASS switching documents preserves an unqueued note unless discard is confirmed");

const unload = { defaultPrevented: false, returnValue: "initial", preventDefault() { this.defaultPrevented = true; } };
element("note").value = "Keep before leaving";
windowListeners.get("beforeunload")!(unload);
assert.equal(unload.defaultPrevented, true);
assert.equal(unload.returnValue, "");
console.log("PASS offline reader warns before unloading an unqueued note");


test("offline reader applies the app theme and follows saved or system preference changes", () => {
    assert.equal(root.dataset.theme, "dark");
    storedTheme = "light";
    windowListeners.get("storage")!({ key: "zuychin-theme" });
    assert.equal(root.dataset.theme, "light");
    systemDark = true;
    themeListeners.forEach(listener => listener());
    assert.equal(root.dataset.theme, "light", "An explicit app preference overrides the system");
    storedTheme = "unknown";
    windowListeners.get("storage")!({ key: "zuychin-theme" });
    assert.equal(root.dataset.theme, "dark");
    themeStorageUnavailable = true;
    systemDark = false;
    themeListeners.forEach(listener => listener());
    assert.equal(root.dataset.theme, "light", "Blocked storage falls back to the current system preference");
});

test("offline read failure exposes retry without losing the open document or draft", async () => {
    const title = element("title").textContent;
    element("note").value = "Keep this unqueued note after a failed read";
    failRead = true;
    try {
        await assert.doesNotReject(() => vm.runInContext("read()", context) as Promise<void>);
        assert.equal(element("status").attributes.get("role"), "alert");
        assert.match(element("status").textContent, /Could not read/);
        assert.equal(element("retry").hidden, false);
        assert.equal(element("title").textContent, title);
        assert.equal(element("note").value, "Keep this unqueued note after a failed read");
    } finally { failRead = false; }
    await element("retry").onclick!();
    assert.equal(element("retry").hidden, true);
    assert.equal(element("status").attributes.get("role"), "status");
    assert.match(element("status").textContent, /downloaded documents/);
    assert.equal(element("title").textContent, title);
    assert.equal(element("note").value, "Keep this unqueued note after a failed read");
});

test("offline reader uses singular and plural document and queued-note counts", async () => {
    const previous = saved;
    try {
        for (const [documents, notes, expected] of [
            [0, 0, "0 downloaded documents. 0 notes queued."],
            [1, 0, "1 downloaded document. 0 notes queued."],
            [2, 1, "2 downloaded documents. 1 note queued."],
            [1, 2, "1 downloaded document. 2 notes queued."],
        ] as const) {
            saved = {
                ...previous,
                documents: Array.from({ length: documents }, (_, index) => ({ ...document, documentId: `count-${index}` })),
                queue: Array.from({ length: notes }, () => previous.queue[0]),
            };
            await vm.runInContext("read()", context);
            assert.ok(element("status").textContent.startsWith(expected));
        }
    } finally { saved = previous; }
});
