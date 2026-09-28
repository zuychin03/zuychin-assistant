import assert from "node:assert/strict";
import { installUnsavedChangesGuard } from "../src/components/use-unsaved-changes";

const browserListeners = new Map<string, (event: unknown) => void>();
const documentListeners = new Map<string, (event: unknown) => void>();
let dirty = true, accept = false, confirmations = 0;
const browser = { location: { href: "https://fixture.invalid/study" }, confirm: () => { confirmations++; return accept; },
    addEventListener: (name: string, callback: (event: unknown) => void) => browserListeners.set(name, callback),
    removeEventListener: (name: string) => browserListeners.delete(name) } as unknown as Window;
const document = { addEventListener: (name: string, callback: (event: unknown) => void, capture: boolean) => { assert.equal(capture, true); documentListeners.set(name, callback); }, removeEventListener: (name: string) => documentListeners.delete(name) } as unknown as Document;
const dispose = installUnsavedChangesGuard(browser, document, () => dirty);
function click(href: string, options: { ctrlKey?: boolean; target?: string; download?: boolean; native?: boolean } = {}) {
    const link = { href, target: options.target || "", hasAttribute: (name: string) => (name === "download" && Boolean(options.download)) || (name === "data-native-navigation" && Boolean(options.native)) };
    const event = { target: { closest: () => link }, button: 0, ctrlKey: options.ctrlKey, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    documentListeners.get("click")!(event);
    return event;
}
const rejected = click("/tasks");
assert.equal(rejected.defaultPrevented, true); assert.equal(rejected.stopped, true);
assert.equal(confirmations, 1);
for (const [href, options] of [["/study#workspace-content", {}], ["/tasks", { ctrlKey: true }], ["/tasks", { target: "_blank" }], ["/source.pdf", { download: true }], ["mailto:hello@example.test", {}], ["/capture", { native: true }], ["https://external.invalid/", {}]] as const) {
    assert.equal(click(href, options).defaultPrevented, false);
}
assert.equal(confirmations, 1);
const unload = { defaultPrevented: false, returnValue: "initial", preventDefault() { this.defaultPrevented = true; } };
browserListeners.get("beforeunload")!(unload);
assert.equal(unload.defaultPrevented, true); assert.equal(unload.returnValue, "");
accept = true;
assert.equal(click("/tasks").defaultPrevented, false);
const acceptedUnload = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
browserListeners.get("beforeunload")!(acceptedUnload);
assert.equal(acceptedUnload.defaultPrevented, true, "Accepting a client-side link cannot suppress a later unload when navigation did not occur");
assert.equal(click("/api/capture/original?id=download-without-attribute").defaultPrevented, false);
const afterDownload = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
browserListeners.get("beforeunload")!(afterDownload);
assert.equal(afterDownload.defaultPrevented, true, "An accepted download without a navigation cannot disable later draft protection");
dirty = false; accept = false;
assert.equal(click("/capture").defaultPrevented, false);
assert.equal(confirmations, 3);
dispose(); assert.equal(browserListeners.size, 0); assert.equal(documentListeners.size, 0);
console.log("Unsaved changes: cancelled links blocked before routing, unload guarded, native links defer to unload, accepted downloads retain later protection, safe link variants preserved, listeners removed.");
