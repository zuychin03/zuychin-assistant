import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

interface Element { type: string; props: Record<string, unknown> & { children?: unknown } }
interface RequestStub {
    url: string; method: string; body?: string;
    resolve: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
}

// Actual component handlers run with isolated hooks and mocked browser/network services.
function panel(file: string, globals: Record<string, unknown> = {}, props = {}, replayMountEffects = false) {
    const source = readFileSync(new URL(`../src/app/admin/${file}.tsx`, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const slots: unknown[] = [], effects: (() => void)[] = [], requests: RequestStub[] = [];
    let cursor = 0, tree: Element, firstRender = true;
    const changed = (before: unknown[] | undefined, after: unknown[]) => !before || before.length !== after.length || before.some((value, index) => value !== after[index]);
    const hooks = {
        useState<T>(initial: T) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
            return [slots[index], (value: T | ((previous: T) => T)) => { slots[index] = typeof value === "function" ? (value as (previous: T) => T)(slots[index] as T) : value; }];
        },
        useRef<T>(initial: T) { return slots[cursor++] ??= { current: initial }; },
        useCallback<T>(callback: T, deps: unknown[]) {
            const index = cursor++, previous = slots[index] as { callback: T; deps: unknown[] } | undefined;
            if (!previous || changed(previous.deps, deps)) slots[index] = { callback, deps };
            return (slots[index] as { callback: T }).callback;
        },
        useEffect(callback: () => void, deps: unknown[]) {
            const index = cursor++;
            if (changed(slots[index] as unknown[] | undefined, deps)) { slots[index] = deps; effects.push(callback); }
        },
    };
    const exportsObject = {} as { default: (props: object) => Element };
    const element = (type: string, properties: Element["props"]): Element => ({ type, props: properties });
    vm.runInNewContext(compiled, {
        exports: exportsObject,
        require(name: string) {
            if (name === "react") return hooks;
            if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
            if (name === "lucide-react") return new Proxy({}, { get: (_target, key) => key });
            if (name.endsWith("dropdown")) return { Dropdown: "Dropdown" };
            if (name.endsWith("controls")) return { ConfirmModal: "ConfirmModal" };
            if (name === "@/lib/types") return { PROMOTE_EVIDENCE_COUNT: 2 };
            throw new Error(`Unmocked import: ${name}`);
        },
        fetch(url: string, init?: { method?: string; body?: string }) {
            return new Promise(resolve => requests.push({ url, method: init?.method ?? "GET", body: init?.body, resolve }));
        },
        Date, setTimeout, atob, window: { confirm: () => true }, ...globals,
    });
    function render() {
        cursor = 0; tree = exportsObject.default(props);
        for (const effect of effects.splice(0)) { effect(); if (firstRender && replayMountEffects) effect(); }
        firstRender = false;
    }
    function all(node: unknown = tree): Element[] {
        if (!node || typeof node !== "object") return [];
        if (Array.isArray(node)) return node.flatMap(item => all(item ?? null));
        const current = node as Element;
        return [current, ...all(current.props?.children ?? null)];
    }
    function text(node: unknown = tree): string {
        if (node == null || typeof node === "boolean") return "";
        if (Array.isArray(node)) return node.map(item => text(item)).join(" ");
        if (typeof node === "object") return text((node as Element).props?.children ?? null);
        return String(node);
    }
    const find = (predicate: (node: Element) => boolean) => { const found = all().find(predicate); assert(found, `Control missing in ${file}`); return found; };
    const click = (node: Element) => (node.props.onClick as () => unknown)();
    const title = (value: string) => find(node => node.props.title === value);
    const button = (value: string) => find(node => node.type === "button" && text(node).includes(value));
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); render(); };
    const respond = async (request: RequestStub, data: unknown, ok = true) => { request.resolve({ ok, json: async () => data }); await flush(); };
    render();
    return { render, all, text, find, click, title, button, flush, respond, requests };
}

for (const rollback of [true, false]) test(`failed notification persistence stays truthful and retries when rollback=${rollback}`, async () => {
    let subscription: { endpoint: string; unsubscribe: () => Promise<boolean> } | null = null;
    const registration = { pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => subscription = { endpoint: "https://push.invalid/synthetic", unsubscribe: async () => { if (rollback) subscription = null; return rollback; } },
    } };
    const notification = { permission: "granted", requestPermission: async () => "granted" };
    const globals = {
        navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } },
        window: { PushManager: {}, Notification: notification }, Notification: notification,
        process: { env: { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "AAA" } },
    };
    const ui = panel("notifications-panel", globals);
    await ui.flush();
    ui.click(ui.button("Enable alerts")); await ui.flush();
    await ui.respond(ui.requests.at(-1)!, {}, false);
    assert.equal(subscription === null, rollback);
    assert(!ui.text().includes("This browser can receive reminders"));
    const action = rollback ? "Enable alerts" : "Retry setup";
    if (!rollback) assert(ui.text().includes("Setup not confirmed"));
    if (!rollback) {
        const remounted = panel("notifications-panel", globals);
        await remounted.flush();
        assert.equal(remounted.requests[0]?.method, "GET");
        assert.equal(remounted.requests.filter(request => request.method !== "GET").length, 0);
        await remounted.respond(remounted.requests[0], { registered: false });
        assert(remounted.text().includes("Setup not confirmed"));
        assert(!remounted.text().includes("This browser can receive reminders"));
    }
    assert.equal(ui.button(action).props.disabled, false);
    ui.click(ui.button(action)); await ui.flush();
    assert.equal(ui.requests.at(-1)!.method, "POST");
    await ui.respond(ui.requests.at(-1)!, {});
    assert(ui.text().includes("This browser can receive reminders"));
});

test("notification status requires server confirmation and rechecks a lost delete response", async () => {
    const subscription = { endpoint: "https://push.invalid/synthetic", unsubscribe: async () => false };
    const registration = { pushManager: { getSubscription: async () => subscription } };
    const notification = { permission: "granted", requestPermission: async () => "granted" };
    const globals = {
        navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } },
        window: { PushManager: {}, Notification: notification }, Notification: notification,
        process: { env: { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "AAA" } },
    };
    const ui = panel("notifications-panel", globals);
    await ui.flush();
    assert.equal(ui.requests[0]?.method, "GET");
    await ui.respond(ui.requests[0], {}, false);
    assert(!ui.text().includes("This browser can receive reminders"));
    ui.click(ui.button("Retry status")); await ui.flush();
    assert.equal(ui.requests.at(-1)!.method, "GET");
    await ui.respond(ui.requests.at(-1)!, { registered: true });
    assert(ui.text().includes("This browser can receive reminders"));
    ui.click(ui.button("Turn off alerts")); await ui.flush();
    assert.equal(ui.requests.at(-1)!.method, "DELETE");
    await ui.respond(ui.requests.at(-1)!, {}, false);
    assert.equal(ui.requests.at(-1)!.method, "GET");
    await ui.respond(ui.requests.at(-1)!, { registered: false });
    assert(ui.text().includes("Setup not confirmed"));
    assert(!ui.text().includes("This browser can receive reminders"));
});

test("an older notification status read cannot undo confirmed turn-off", async () => {
    const subscription = { endpoint: "https://push.invalid/synthetic", unsubscribe: async () => true };
    const registration = { pushManager: { getSubscription: async () => subscription } };
    const notification = { permission: "granted" };
    const ui = panel("notifications-panel", {
        navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } },
        window: { PushManager: {}, Notification: notification }, Notification: notification,
        process: { env: { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "AAA" } },
    }, {}, true);
    await ui.flush();
    assert.equal(ui.requests.length, 2);
    const stale = ui.requests[0];
    await ui.respond(ui.requests[1], { registered: true });
    ui.click(ui.button("Turn off alerts")); await ui.flush();
    await ui.respond(ui.requests.at(-1)!, {});
    await ui.respond(stale, { registered: true });
    assert(!ui.text().includes("This browser can receive reminders"));
    assert.equal(ui.button("Enable alerts").props.disabled, false);
});

test("cleanup refresh excludes vanished selections from deletion", async () => {
    const ui = panel("conversation-cleanup-panel");
    await ui.respond(ui.requests[0], { recommendations: [{ conversationId: "old", title: "Old recommendation", score: 90, reason: "Synthetic", reviewedAt: "2026-09-28" }] });
    (ui.find(node => node.type === "input").props.onChange as () => void)(); ui.render();
    assert.equal(ui.button("Delete selected").props.disabled, false);
    ui.click(ui.title("Refresh recommendations")); ui.render();
    assert.equal(ui.button("Delete selected").props.disabled, true);
    await ui.respond(ui.requests.at(-1)!, { recommendations: [] });
    assert.equal(ui.button("Delete selected").props.disabled, true);
    ui.click(ui.button("Delete selected"));
    assert.equal(ui.requests.filter(request => request.method === "DELETE").length, 0);
});

test("refresh reloads expanded run details and rejects an older detail response", async () => {
    const run = { id: "run-1", status: "running", message: "Synthetic run", model: null, plan: [], usage: {}, startedAt: "2026-09-28", finishedAt: null };
    const ui = panel("runs-panel");
    await ui.respond(ui.requests[0], { runs: [run] });
    ui.click(ui.button("Synthetic run")); ui.render();
    const stale = ui.requests.at(-1)!;
    ui.click(ui.title("Refresh runs")); ui.render();
    await ui.respond(ui.requests.at(-1)!, { runs: [{ ...run, status: "error", finishedAt: "2026-09-28" }] });
    const latest = ui.requests.at(-1)!;
    assert.notEqual(latest, stale);
    assert(latest.url.includes("?id=run-1"));
    await ui.respond(latest, { run: { ...run, events: [], reply: null, error: "Current failure" } });
    await ui.respond(stale, { run: { ...run, events: [], reply: null, error: null } });
    assert(ui.text().includes("Current failure"));
});

test("agent creation locks its form and preserves its draft after failure", async () => {
    const ui = panel("agents-panel");
    await ui.respond(ui.requests[0], { clients: [{ id: "agent-1", displayName: "Synthetic agent", kind: "remote_agent", lastSeenAt: null, keys: [{ id: "key-1", purpose: "knowledge", accessLevel: "read", lastUsedAt: null, expiresAt: null }] }] });
    const name = ui.find(node => node.type === "input");
    (name.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Second agent" } }); ui.render();
    ui.click(ui.title("Add agent")); ui.render();
    assert(ui.find(node => node.type === "input").props.disabled);
    assert(ui.all().filter(node => node.type === "Dropdown").every(node => node.props.disabled));
    await ui.respond(ui.requests.at(-1)!, {}, false);
    assert.equal(ui.find(node => node.type === "input").props.value, "Second agent");
});

for (const kind of ["agent", "key"]) test(`${kind} revocation confirms its target, locks pending requests and retries failure without losing drafts`, async () => {
    const client = { id: "agent-1", displayName: "Synthetic agent", kind: "remote_agent", lastSeenAt: null, keys: [{ id: "key-1", purpose: "knowledge", accessLevel: "read", lastUsedAt: null, expiresAt: null }] };
    const ui = panel("agents-panel");
    await ui.respond(ui.requests[0], { clients: [client] });
    (ui.find(node => node.type === "input").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Unsaved next agent" } }); ui.render();
    const title = kind === "agent" ? "Revoke this agent and every key it holds" : "Revoke this credential";
    ui.click(ui.title(title)); ui.render();
    const dialog = () => ui.find(node => node.type === "ConfirmModal");
    assert(String(dialog().props.body).includes("Synthetic agent"));
    assert(String(dialog().props.body).includes(kind === "agent" ? "every credential" : "other credentials will stay active"));
    assert.equal(ui.requests.filter(request => request.method === "DELETE").length, 0);
    (dialog().props.onCancel as () => void)(); ui.render();
    assert(!ui.all().some(node => node.type === "ConfirmModal"));
    assert.equal(ui.find(node => node.type === "input").props.value, "Unsaved next agent");
    ui.click(ui.title(title)); ui.render();
    const confirm = dialog().props.onConfirm as () => void;
    confirm(); confirm(); ui.render();
    assert.equal(ui.requests.filter(request => request.method === "DELETE").length, 1);
    assert.equal(ui.requests.at(-1)!.url, kind === "agent" ? "/api/agents?id=agent-1" : "/api/agents/keys?keyId=key-1");
    assert(dialog().props.busyText);
    (dialog().props.onCancel as () => void)(); ui.render();
    assert(dialog());
    await ui.respond(ui.requests.at(-1)!, {}, false);
    assert.equal(dialog().props.error, "Revocation was not confirmed. Please retry.");
    assert.equal(dialog().props.busyText, undefined);
    assert.equal(ui.find(node => node.type === "input").props.value, "Unsaved next agent");
    (dialog().props.onConfirm as () => void)(); ui.render();
    assert.equal(ui.requests.filter(request => request.method === "DELETE").length, 2);
    await ui.respond(ui.requests.at(-1)!, {});
    assert.equal(ui.requests.at(-1)!.method, "GET");
    await ui.respond(ui.requests.at(-1)!, { clients: kind === "agent" ? [] : [{ ...client, keys: [] }] });
    assert(!ui.all().some(node => node.type === "ConfirmModal"));
    assert.equal(ui.find(node => node.type === "input").props.value, "Unsaved next agent");
});

for (const kind of ["memories", "skills"]) test(`${kind} deletion requires confirmation and preserves a draft on cancellation`, async () => {
    const memory = { id: "one", fact: "First fact", category: "fact", updatedAt: "2026-09-28" };
    const skill = { id: "one", name: "First skill", slug: "first", instructions: "First instructions", status: "active", whenToUse: "Synthetic" };
    const ui = panel(`${kind}-panel`);
    await ui.respond(ui.requests[0], kind === "memories" ? { memories: [memory, { ...memory, id: "two", fact: "Second fact" }] } : { custom: [skill, { ...skill, id: "two", name: "Second skill" }], builtIn: [] });
    if (kind === "skills") { ui.click(ui.button("First skill")); ui.render(); }
    ui.click(ui.title(kind === "memories" ? "Edit fact" : "Edit instructions")); ui.render();
    (ui.find(node => node.type === "textarea").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Unsaved draft" } }); ui.render();
    if (kind === "skills") { ui.click(ui.button("Second skill")); ui.render(); }
    ui.click(ui.title(kind === "memories" ? "Forget fact" : "Delete skill")); ui.render();
    assert.equal(ui.requests.filter(request => request.method === "DELETE").length, 0);
    const confirmation = ui.find(node => node.type === "ConfirmModal");
    (confirmation.props.onCancel as () => void)(); ui.render();
    if (kind === "skills") { ui.click(ui.button("First skill")); ui.render(); }
    assert.equal(ui.find(node => node.type === "textarea").props.value, "Unsaved draft");
    if (kind === "skills") { ui.click(ui.button("Second skill")); ui.render(); }
    ui.click(ui.title(kind === "memories" ? "Forget fact" : "Delete skill")); ui.render();
    (ui.find(node => node.type === "ConfirmModal").props.onConfirm as () => void)(); ui.render();
    assert.equal(ui.requests.at(-1)!.method, "DELETE");
    await ui.respond(ui.requests.at(-1)!, {}, false);
    assert(ui.all().some(node => node.props.role === "alert"));
    if (kind === "skills") { ui.click(ui.button("First skill")); ui.render(); }
    assert.equal(ui.find(node => node.type === "textarea").props.value, "Unsaved draft");
});

for (const kind of ["memories", "skills"]) test(`${kind} blocks mutations while refresh is pending`, async () => {
    const ui = panel(`${kind}-panel`);
    const payload = kind === "memories" ? { memories: [{ id: "one", fact: "A fact", category: "fact", updatedAt: "2026-09-28" }] }
        : { custom: [{ id: "one", name: "A skill", slug: "a", instructions: "Instructions", status: "draft", whenToUse: "Synthetic" }], builtIn: [] };
    await ui.respond(ui.requests[0], payload);
    if (kind === "skills") { ui.click(ui.button("A skill")); ui.render(); }
    else { (ui.find(node => node.type === "input").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "New fact" } }); ui.render(); }
    ui.click(ui.title(kind === "memories" ? "Refresh memories" : "Refresh skills")); ui.render();
    const mutation = kind === "memories" ? ui.title("Save fact") : ui.button("Approve");
    assert.equal(mutation.props.disabled, true);
    ui.click(mutation);
    assert.equal(ui.requests.filter(request => request.method !== "GET").length, 0);
    await ui.respond(ui.requests.at(-1)!, payload);
    assert.equal((kind === "memories" ? ui.title("Save fact") : ui.button("Approve")).props.disabled, false);
});

test("push status read enforces the owner session, origin, bounded endpoint and no-store responses", async () => {
    const source = readFileSync(new URL("../src/app/api/push/subscribe/route.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const endpoint = "https://push.invalid/registered";
    let fail = false;
    const lookups: string[] = [];
    const database = { from(table: string) {
        assert.equal(table, "push_subscriptions");
        return { select(columns: string) {
            assert.equal(columns, "id");
            return { eq(column: string, value: string) {
                assert.equal(column, "endpoint"); lookups.push(value);
                return { maybeSingle: async () => ({ data: value === endpoint ? { id: "row-1" } : null, error: fail ? new Error("Synthetic unavailable storage") : null }) };
            } };
        } };
    } };
    type RequestInput = { headers: Headers; nextUrl: URL; cookies: { get: (name: string) => { value: string } | undefined } };
    const exported = {} as { GET: (request: RequestInput) => Promise<Response> };
    vm.runInNewContext(compiled, { exports: exported, URL, require(name: string) {
        if (name === "next/server") return { NextResponse: { json: Response.json } };
        if (name === "@/lib/supabase") return { supabaseAdmin: database };
        if (name === "@/lib/auth/config") return { AUTH_COOKIE: "owner-cookie", authEnabled: () => true };
        if (name === "@/lib/auth/session") return { verifySessionValue: async (value?: string) => value === "valid-owner-session" };
        throw new Error(`Unmocked route import: ${name}`);
    } });
    async function read(value: string | null, session?: string, origin?: string) {
        const headers = new Headers();
        if (value !== null) headers.set("X-Push-Endpoint", value);
        if (origin) headers.set("Origin", origin);
        const response = await exported.GET({ headers, nextUrl: new URL("https://fixture.invalid/api/push/subscribe"), cookies: { get: name => name === "owner-cookie" && session ? { value: session } : undefined } });
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        return response;
    }
    assert.equal((await read(endpoint)).status, 401);
    assert.equal((await read(endpoint, "wrong-session")).status, 401);
    assert.equal((await read(endpoint, "valid-owner-session", "https://another.invalid")).status, 403);
    for (const value of [null, "http://push.invalid/plain", "https://user:password@push.invalid/endpoint", "https://push.invalid/path#fragment", `https://push.invalid/${"x".repeat(4096)}`]) {
        assert.equal((await read(value, "valid-owner-session")).status, 400);
    }
    assert.equal(lookups.length, 0);
    const registered = await read(endpoint, "valid-owner-session", "https://fixture.invalid");
    assert.deepEqual(await registered.json(), { registered: true });
    assert.deepEqual(await (await read(`${endpoint}-different`, "valid-owner-session")).json(), { registered: false });
    assert.deepEqual(lookups, [endpoint, `${endpoint}-different`]);
    fail = true;
    const unavailable = await read(endpoint, "valid-owner-session");
    assert.equal(unavailable.status, 503);
    assert.equal("registered" in await unavailable.json(), false);
});
