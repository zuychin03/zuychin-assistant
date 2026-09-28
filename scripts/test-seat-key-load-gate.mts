import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

interface Element {
    type: string;
    props: {
        children?: unknown;
        disabled?: boolean;
        onClick?: () => void;
        onChange?: (value: string) => void;
        onConfirm?: () => void;
        onCancel?: () => void;
    };
}
interface ResponseStub { ok: boolean; json: () => Promise<unknown> }
interface RequestStub {
    method: string;
    resolve: (response: ResponseStub) => void;
    reject: (error: Error) => void;
}

const source = readFileSync(new URL("../src/app/council/seat-keys-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const slots: unknown[] = [], effects: (() => void)[] = [], requests: RequestStub[] = [];
let cursor = 0, tree: Element;
const changed = (previous: unknown[] | undefined, current: unknown[]) => !previous || previous.length !== current.length || previous.some((value, index) => value !== current[index]);

// Hooks isolate actual component callbacks; this does not simulate browser rendering.
const hooks = {
    useState<T>(initial: T) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value: T | ((previous: T) => T)) => {
            slots[index] = typeof value === "function" ? (value as (previous: T) => T)(slots[index] as T) : value;
        }];
    },
    useRef<T>(initial: T) {
        const index = cursor++;
        return slots[index] ??= { current: initial };
    },
    useCallback<T>(callback: T, deps: unknown[]) {
        const index = cursor++;
        const previous = slots[index] as { callback: T; deps: unknown[] } | undefined;
        if (!previous || changed(previous.deps, deps)) slots[index] = { callback, deps };
        return (slots[index] as { callback: T }).callback;
    },
    useEffect(callback: () => void, deps: unknown[]) {
        const index = cursor++;
        if (changed(slots[index] as unknown[] | undefined, deps)) { slots[index] = deps; effects.push(callback); }
    },
};
const exportsObject = {} as { SeatKeysPanel: (props: { code: string; agentNames: string[] }) => Element };
const element = (type: string, props: Element["props"]): Element => ({ type, props });
vm.runInNewContext(code, {
    exports: exportsObject,
    require(name: string) {
        if (name === "react") return hooks;
        if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
        if (name === "lucide-react") return Object.fromEntries(["Check", "Copy", "FileKey", "KeyRound", "Trash2"].map(name => [name, name]));
        if (name.endsWith("dropdown")) return { Dropdown: "Dropdown" };
        if (name.endsWith("controls")) return { ConfirmModal: "ConfirmModal" };
        return {};
    },
    fetch(_url: string, init?: { method?: string }) {
        return new Promise<ResponseStub>((resolve, reject) => requests.push({ method: init?.method ?? "GET", resolve, reject }));
    },
    Date, setTimeout,
});
function render() {
    cursor = 0;
    tree = exportsObject.SeatKeysPanel({ code: "SYNTHETIC", agentNames: ["reviewer-a"] });
    for (const effect of effects.splice(0)) effect();
}
function all(node: unknown): Element[] {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(all);
    const current = node as Element;
    return [current, ...all(current.props?.children)];
}
function control(predicate: (element: Element) => boolean): Element {
    const result = all(tree).find(predicate);
    assert(result, "Expected component control was not rendered");
    return result;
}
const dropdown = () => control(node => node.type === "Dropdown");
const issue = () => control(node => node.type === "button" && ["Issue", "Replace key", "Issuing…"].includes(String(node.props.children)));
const refresh = () => control(node => node.type === "button" && node.props.children === "Refresh keys");
const modal = () => control(node => node.type === "ConfirmModal");
const hasModal = () => all(tree).some(node => node.type === "ConfirmModal");
const posts = () => requests.filter(request => request.method === "POST").length;
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); render(); };
const respond = async (request: RequestStub, data: unknown, ok = true) => { request.resolve({ ok, json: async () => data }); await flush(); };

render();
assert(dropdown().props.disabled && issue().props.disabled);
dropdown().props.onChange!("reviewer-a"); render();
issue().props.onClick!(); assert.equal(posts(), 0);
requests[0].reject(new Error("Synthetic network failure")); await flush();
assert(issue().props.disabled && refresh());
issue().props.onClick!(); assert.equal(posts(), 0);
refresh().props.onClick!(); render();
await respond(requests.at(-1)!, {});
assert(issue().props.disabled && refresh());
refresh().props.onClick!(); render();
await respond(requests.at(-1)!, { keys: [] });
assert(!issue().props.disabled && !dropdown().props.disabled);
issue().props.onClick!(); render();
assert.equal(posts(), 1);
await respond(requests.at(-1)!, { error: "Synthetic issue rejection" }, false);
const readyIssue = issue().props.onClick!;
refresh().props.onClick!();
readyIssue(); assert.equal(posts(), 1);
render(); assert(issue().props.disabled);
await respond(requests.at(-1)!, { error: "Synthetic refresh rejection" }, false);
assert(issue().props.disabled);
issue().props.onClick!(); assert.equal(posts(), 1);
refresh().props.onClick!(); render();
await respond(requests.at(-1)!, { keys: [{ seatName: "reviewer-a", issuedAt: "2026-09-28", expiresAt: "2027-01-01", claimedAt: null, revokedAt: null }] });
assert.equal(issue().props.children, "Replace key");
issue().props.onClick!(); render();
assert(hasModal()); assert.equal(posts(), 1);
modal().props.onCancel!(); render();
assert(!hasModal()); assert.equal(posts(), 1);
issue().props.onClick!(); render();
const confirmedMint = modal().props.onConfirm!;
confirmedMint(); render(); assert.equal(posts(), 2);
await respond(requests.at(-1)!, { error: "Synthetic replacement rejection" }, false);
refresh().props.onClick!();
confirmedMint(); assert.equal(posts(), 2);
render(); assert(issue().props.disabled && issue().props.children === "Replace key");
await respond(requests.at(-1)!, { error: "Synthetic refresh rejection" }, false);
assert(issue().props.disabled && issue().props.children === "Replace key");
console.log("Seat-key load gate passed: pending, failed and malformed loads, retry, stale handlers, retained keys, replacement confirmation and cancellation. All requests mocked.");
