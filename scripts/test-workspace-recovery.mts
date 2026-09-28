import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { eligibleChatProviders, resolveChatSelection } from "../src/app/home/chat-policy.ts";

function extract(path: string, names: string[], guardName?: string) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declarations: string[] = [];
    function visit(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.push(node.getText(tree));
        if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree)) && node.initializer) {
            const value = ts.isCallExpression(node.initializer) && node.initializer.expression.getText(tree) === "useCallback"
                ? node.initializer.arguments[0] : node.initializer;
            declarations.push(`const ${node.name.getText(tree)} = ${value.getText(tree)};`);
        }
        if (guardName && ts.isCallExpression(node) && node.expression.getText(tree) === "useUnsavedChanges") declarations.push(`const ${guardName} = ${node.arguments[0].getText(tree)};`);
        ts.forEachChild(node, visit);
    }
    visit(tree);
    const exports = [...names, ...(guardName ? [guardName] : [])];
    assert.equal(declarations.length, exports.length);
    return ts.transpileModule([...declarations, `({ ${exports.join(", ")} });`].join("\n"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
}

const maintenance = extract("../src/app/knowledge/page.tsx", ["loadSuggestions", "scanMaintenance", "dismissSuggestion"]);
const branch = extract("../src/app/conversations/branch-navigation.tsx", ["selectBranch"]);
type Suggestion = { id: string };
type ResponseBody = { suggestions?: Suggestion[]; error?: string };
function setup() {
    let suggestions: Suggestion[] = [{ id: "dismiss-me" }, { id: "keep-me" }];
    let loadState = { suggestions: "ready" };
    const pending: Array<{ complete: (body: ResponseBody, ok?: boolean) => void }> = [];
    const actions = runInNewContext(maintenance, {
        suggestionListRequest: { current: 0 },
        fetch: () => new Promise((resolve) => pending.push({ complete: (body, ok = true) => resolve({ ok, json: async () => body }) })),
        setSuggestions: (value: Suggestion[] | ((current: Suggestion[]) => Suggestion[])) => { suggestions = typeof value === "function" ? value(suggestions) : value; },
        setLoadState: (value: (current: typeof loadState) => typeof loadState) => { loadState = value(loadState); },
        setBusy: () => undefined,
        setError: () => undefined,
    }) as { loadSuggestions: () => Promise<void>; scanMaintenance: () => Promise<void>; dismissSuggestion: (id: string) => Promise<void> };
    return { actions, pending, ids: () => suggestions.map((item) => item.id), status: () => loadState.suggestions };
}

test("a later review-queue request wins even when an earlier request finishes last", async () => {
    const f = setup();
    const earlier = f.actions.loadSuggestions(), later = f.actions.loadSuggestions();
    f.pending[1].complete({ suggestions: [{ id: "latest" }] }); await later;
    f.pending[0].complete({ suggestions: [{ id: "stale" }] }); await earlier;
    assert.deepEqual(f.ids(), ["latest"]);
    assert.equal(f.status(), "ready");
});

test("an outdated queue failure cannot replace a successful refresh with an error", async () => {
    const f = setup();
    const earlier = f.actions.loadSuggestions(), later = f.actions.loadSuggestions();
    f.pending[1].complete({ suggestions: [] }); await later;
    f.pending[0].complete({ error: "Old request failed" }, false); await earlier;
    assert.equal(f.status(), "ready");
});

test("dismissing a suggestion cannot be undone by an already pending queue response", async () => {
    const f = setup();
    const queue = f.actions.loadSuggestions(), dismiss = f.actions.dismissSuggestion("dismiss-me");
    f.pending[1].complete({}); await dismiss;
    f.pending[0].complete({ suggestions: [{ id: "dismiss-me" }, { id: "keep-me" }] }); await queue;
    assert.deepEqual(f.ids(), ["keep-me"]);
    assert.equal(f.status(), "ready");
});

test("fresh scan findings survive a slower pre-scan queue response", async () => {
    const f = setup();
    const queue = f.actions.loadSuggestions(), scan = f.actions.scanMaintenance();
    f.pending[1].complete({ suggestions: [{ id: "new-finding" }] }); await scan;
    f.pending[0].complete({ suggestions: [] }); await queue;
    assert.deepEqual(f.ids(), ["new-finding"]);
    assert.equal(f.status(), "ready");
});

test("a current queue failure still exposes its error for the Retry flow", async () => {
    const f = setup();
    const queue = f.actions.loadSuggestions();
    f.pending[0].complete({ error: "Queue unavailable" }, false);
    await assert.rejects(queue, /Queue unavailable/);
    assert.equal(f.status(), "error");
});

type Click = { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void };
function click(overrides: Partial<Click> = {}): Click {
    const event = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => { event.defaultPrevented = true; }, ...overrides };
    return event;
}
function selectWith(onSelect?: (id: string) => void) {
    return (runInNewContext(branch, { onSelect }) as { selectBranch: (event: Click, id: string) => void }).selectBranch;
}

test("ordinary related-branch clicks select in place", () => {
    const selected: string[] = [];
    const event = click();
    selectWith((id) => selected.push(id))(event, "branch-b");
    assert.deepEqual(selected, ["branch-b"]);
    assert.equal(event.defaultPrevented, true);
});

test("modified or already handled branch clicks preserve browser navigation", () => {
    const selected: string[] = [];
    const select = selectWith((id) => selected.push(id));
    for (const override of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
        const event = click(override);
        select(event, "branch-b");
        assert.equal(event.defaultPrevented, Boolean(override.defaultPrevented));
    }
    assert.deepEqual(selected, []);
});

test("branch links without an in-place selector retain normal navigation", () => {
    const event = click();
    selectWith()(event, "branch-b");
    assert.equal(event.defaultPrevented, false);
});

const instructions = extract("../src/app/home/conversation-list.tsx", ["instructionsDirty", "perform", "submitInstructions", "openInstructions", "closeInstructions"], "needsProtection");
const navigation = extract("../src/components/use-unsaved-changes.ts", ["installUnsavedChangesGuard"]);
type Project = { id: string; instructions: string };
type InstructionActions = {
    openInstructions: (project: Project) => void;
    closeInstructions: () => void;
    submitInstructions: () => Promise<void>;
    needsProtection: () => boolean;
};
function instructionFixture({ accept = false, text = "Authored instructions", save = async () => false }: { accept?: boolean; text?: string; save?: () => Promise<boolean> } = {}) {
    const prompts: string[] = [], saves: Array<[string, { instructions: string }]> = [];
    const state: Record<string, unknown> = {
        instructionsId: "project-a", instructionsDraft: text, instructionsBase: "Saved instructions", pendingAction: null,
        pendingRef: { current: null }, instructionsRef: { current: { focus() {} } },
        window: { confirm: (message: string) => { prompts.push(message); return accept; } },
        onUpdateProject: async (id: string, patch: { instructions: string }) => { saves.push([id, patch]); return save(); },
        setMenuFor: () => undefined,
    };
    for (const [setter, key] of [["setInstructionsId", "instructionsId"], ["setInstructionsDraft", "instructionsDraft"], ["setInstructionsBase", "instructionsBase"], ["setPendingAction", "pendingAction"]]) {
        state[setter] = (value: unknown) => { state[key] = value; };
    }
    const actions = runInNewContext(instructions, state) as InstructionActions;
    return { actions, state, prompts, saves };
}
const otherProject = { id: "project-b", instructions: "Other saved instructions" };

test("reopening the same project retains authored instructions without prompting", () => {
    const f = instructionFixture();
    f.actions.openInstructions({ id: "project-a", instructions: "Saved instructions" });
    assert.equal(f.state.instructionsDraft, "Authored instructions");
    assert.equal(f.state.instructionsBase, "Saved instructions");
    assert.deepEqual(f.prompts, []);
});

test("cancelling an instruction-project switch preserves its identity, text and baseline", () => {
    const f = instructionFixture();
    f.actions.openInstructions(otherProject);
    assert.equal(f.state.instructionsId, "project-a");
    assert.equal(f.state.instructionsDraft, "Authored instructions");
    assert.equal(f.state.instructionsBase, "Saved instructions");
    assert.equal(f.prompts.length, 1);
});

test("accepting an instruction-project switch installs the next text and baseline together", () => {
    const f = instructionFixture({ accept: true });
    f.actions.openInstructions(otherProject);
    assert.equal(f.state.instructionsId, "project-b");
    assert.equal(f.state.instructionsDraft, otherProject.instructions);
    assert.equal(f.state.instructionsBase, otherProject.instructions);
    assert.equal(f.prompts.length, 1);
});

test("cancelling closure retains edited project instructions", () => {
    const f = instructionFixture();
    f.actions.closeInstructions();
    assert.equal(f.state.instructionsId, "project-a");
    assert.equal(f.state.instructionsDraft, "Authored instructions");
    assert.equal(f.prompts.length, 1);
});

test("accepting closure explicitly clears the instruction draft", () => {
    const f = instructionFixture({ accept: true });
    f.actions.closeInstructions();
    assert.equal(f.state.instructionsId, null);
    assert.equal(f.state.instructionsDraft, "");
    assert.equal(f.state.instructionsBase, "");
    assert.equal(f.prompts.length, 1);
});

test("dirty instructions block rejected navigation and protect a document unload", () => {
    const f = instructionFixture();
    const browserListeners = new Map<string, (event: unknown) => void>(), documentListeners = new Map<string, (event: unknown) => void>();
    const browser = { location: { href: "https://fixture.invalid/" }, confirm: () => false,
        addEventListener: (name: string, callback: (event: unknown) => void) => browserListeners.set(name, callback),
        removeEventListener: (name: string) => browserListeners.delete(name) };
    const document = { addEventListener: (name: string, callback: (event: unknown) => void) => documentListeners.set(name, callback), removeEventListener: (name: string) => documentListeners.delete(name) };
    const { installUnsavedChangesGuard } = runInNewContext(navigation, { URL, exports: {} }) as { installUnsavedChangesGuard: (browser: unknown, document: unknown, dirty: () => boolean) => () => void };
    const dispose = installUnsavedChangesGuard(browser, document, f.actions.needsProtection);
    const event = { button: 0, defaultPrevented: false, target: { closest: () => ({ href: "/graph", hasAttribute: () => false }) },
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    documentListeners.get("click")!(event);
    assert.equal(event.defaultPrevented, true);
    const unload = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    browserListeners.get("beforeunload")!(unload);
    assert.equal(unload.defaultPrevented, true);
    assert.equal(f.state.instructionsDraft, "Authored instructions");
    dispose();
});

test("a pending instruction save blocks replacement, closing and duplicate submission", async () => {
    let release: ((saved: boolean) => void) | undefined;
    const f = instructionFixture({ save: () => new Promise(resolve => { release = resolve; }) });
    const pending = f.actions.submitInstructions();
    f.actions.openInstructions(otherProject); f.actions.closeInstructions();
    await f.actions.submitInstructions();
    assert.equal(f.state.instructionsId, "project-a");
    assert.equal(f.state.instructionsDraft, "Authored instructions");
    assert.equal(f.saves.length, 1);
    assert.equal(f.actions.needsProtection(), true);
    assert(release); release(false); await pending;
    assert.equal(f.state.pendingAction, null);
});

test("an unconfirmed save retains instruction text for retry", async () => {
    const f = instructionFixture();
    await f.actions.submitInstructions();
    assert.equal(f.state.instructionsId, "project-a");
    assert.equal(f.state.instructionsDraft, "Authored instructions");
    assert.equal(f.state.instructionsBase, "Saved instructions");
    assert.equal(f.state.pendingAction, null);
});

test("a rejected save also retains text and releases its pending lock", async () => {
    const f = instructionFixture({ save: async () => { throw new Error("Offline"); } });
    await assert.rejects(f.actions.submitInstructions(), /Offline/);
    assert.equal(f.state.instructionsId, "project-a");
    assert.equal(f.state.instructionsDraft, "Authored instructions");
    assert.equal(f.state.pendingAction, null);
    assert.equal((f.state.pendingRef as { current: unknown }).current, null);
});

test("a confirmed instruction save closes the editor after acknowledgement", async () => {
    const f = instructionFixture({ save: async () => true });
    await f.actions.submitInstructions();
    assert.equal(f.state.instructionsId, null);
    assert.equal(f.saves[0][0], "project-a");
    assert.equal(f.saves[0][1].instructions, "Authored instructions");
});

test("unchanged instructions need no discard prompt or navigation warning", () => {
    const f = instructionFixture({ text: "Saved instructions" });
    assert.equal(f.actions.needsProtection(), false);
    f.actions.closeInstructions();
    assert.equal(f.state.instructionsId, null);
    assert.deepEqual(f.prompts, []);
});

test("failed instruction saves name the visible retry control without replaying a stale draft", async () => {
    const source = extract("../src/app/page.tsx", ["runAction", "handleUpdateProject"]);
    let error: { message: string; retry?: unknown } | null = null;
    const actions = runInNewContext(source, {
        Error,
        pendingActionsRef: { current: new Set<string>() },
        setPendingActions: () => undefined,
        setActionError: (value: typeof error) => { error = value; },
        requestJson: async () => { throw new Error("Unavailable"); },
        loadProjects: async () => true,
    }) as { handleUpdateProject(id: string, patch: { name?: string; instructions?: string }): Promise<boolean> };
    assert.equal(await actions.handleUpdateProject("a", { instructions: "Keep this draft" }), false);
    assert.match(error!.message, /choose Save instructions to try again/);
    assert.equal(error!.retry, undefined);
    assert.equal(await actions.handleUpdateProject("a", { name: "Rename" }), false);
    assert.doesNotMatch(error!.message, /Save instructions/);
});

function stateSetters(state: Record<string, unknown>, keys: string[]) {
    for (const key of keys) state[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value: unknown) => {
        state[key] = typeof value === "function" ? value(state[key]) : value;
    };
}

function captureFixture() {
    const state: Record<string, unknown> = {
        Error, active: { current: true }, privacyRevision: { current: 0 }, inboxRequest: { current: 0 }, locked: { current: false },
        inboxLoading: true, inboxLoaded: false, inboxError: "", items: [], documents: [], busy: "", error: "", notice: "",
        message: (error: Error) => error.message,
        offlineLibrary: { read: async () => ({ epoch: "current" }), bindProfile: async () => ({ epoch: "current", profileId: "owner" }) },
        refreshOffline: async () => undefined,
        request: async () => { throw new Error("Inbox unavailable"); },
    };
    stateSetters(state, ["inboxLoading", "inboxLoaded", "inboxError", "items", "documents", "profileId", "token", "error", "notice", "busy"]);
    const actions = runInNewContext(extract("../src/app/capture/page.tsx", ["load", "action"]), state) as {
        load: () => Promise<void>; action: (name: string, run: () => Promise<void>) => Promise<void>;
    };
    return { state, actions };
}

function inboxText(state: Record<string, unknown>) {
    const source = readFileSync(new URL("../src/app/capture/page.tsx", import.meta.url), "utf8");
    const tree = ts.createSourceFile("capture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let section = "";
    function visit(node: ts.Node) {
        if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
            && attribute.name.getText(tree) === "aria-labelledby" && attribute.initializer?.getText(tree) === '"inbox"')) section = node.getText(tree);
        ts.forEachChild(node, visit);
    }
    visit(tree); assert(section);
    const code = ts.transpileModule(`(${section});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
    return runInNewContext(code, { ...state, selected: undefined, styles: {}, RefreshCw: "icon",
        React: { createElement: (_tag: unknown, _props: unknown, ...children: unknown[]) => children.flat(Infinity).filter(value => typeof value === "string").join(" ") },
    }) as string;
}

test("failed inbox loads remain errors across unrelated successful offline actions", async () => {
    const f = captureFixture();
    await f.actions.load();
    assert.equal(f.state.inboxLoading, false); assert.equal(f.state.inboxLoaded, false);
    assert.match(inboxText(f.state), /Inbox unavailable/); assert.doesNotMatch(inboxText(f.state), /No captures yet/);
    await f.actions.action("note", async () => { f.state.notice = "Note queued"; });
    assert.equal(f.state.error, ""); assert.equal(f.state.inboxError, "Inbox unavailable");
    assert.doesNotMatch(inboxText(f.state), /No captures yet/);
});

test("inbox retry shows loading until a successful empty response confirms the empty state", async () => {
    const f = captureFixture(); await f.actions.load();
    let release!: (value: unknown) => void;
    f.state.request = () => new Promise(resolve => { release = resolve; });
    const pending = f.actions.load();
    assert.match(inboxText(f.state), /Loading your inbox/); assert.doesNotMatch(inboxText(f.state), /No captures yet/);
    await new Promise(resolve => setImmediate(resolve));
    release({ items: [], documents: [], profileId: "owner" }); await pending;
    assert.equal(f.state.inboxError, ""); assert.equal(f.state.inboxLoaded, true);
    assert.match(inboxText(f.state), /No captures yet/);
});

test("failed refreshes retain known captures and distinguish stale content from an empty inbox", async () => {
    const f = captureFixture();
    const items = [{ id: "saved", source: { title: "Existing capture", kind: "text" } }];
    Object.assign(f.state, { inboxLoaded: true, items }); await f.actions.load();
    assert.equal(f.state.items, items); assert.equal(f.state.inboxLoaded, true);
    assert.match(inboxText(f.state), /Existing capture/); assert.match(inboxText(f.state), /may be out of date/);
    assert.doesNotMatch(inboxText(f.state), /No captures yet/);
});

test("a malformed inbox response cannot confirm an empty inbox", async () => {
    const f = captureFixture(); f.state.request = async () => ({ profileId: "owner" }); await f.actions.load();
    assert.equal(f.state.inboxLoaded, false); assert.match(String(f.state.inboxError), /response could not be read/);
    assert.doesNotMatch(inboxText(f.state), /No captures yet/);
});

test("stale inbox failure cannot replace a newer successful read", async () => {
    const f = captureFixture();
    let reject!: (reason: Error) => void;
    f.state.request = () => new Promise((_resolve, fail) => { reject = fail; });
    const old = f.actions.load(); await new Promise(resolve => setImmediate(resolve));
    f.state.request = async () => ({ items: [], profileId: "owner" }); await f.actions.load();
    reject(new Error("Stale failure")); await old;
    assert.equal(f.state.inboxLoaded, true); assert.equal(f.state.inboxError, "");
});

test("authentication clearing during inbox reload preserves the sign-in error without repopulating private data", async () => {
    const f = captureFixture();
    f.state.request = async () => {
        (f.state.privacyRevision as { current: number }).current++;
        throw new Error("Sign in again to use the capture inbox.");
    };
    await f.actions.action("reload", f.actions.load);
    assert.match(String(f.state.error), /Sign in again/); assert.equal(f.state.inboxLoaded, false);
    assert.deepEqual(f.state.items, []);
});

const freeProvider = { id: "fixture", available: true, chatModels: [{ id: "free", free: true }, { id: "other", free: true }], embeddingModels: [] };
function providerFixture() {
    const pending: Array<{ finish: (body: unknown, ok?: boolean) => void; reject: (error: Error) => void }> = [];
    const state: Record<string, unknown> = {
        Error, providerRequest: { current: 0 }, providers: [], providersLoading: true, providersLoaded: false, providersError: "", chatSel: "", embedSel: "",
        freeOnly: true, knowledgeOnly: false, preferencesLoaded: true, preferencesSaving: false, preferencesError: null,
        eligibleChatProviders, resolveChatSelection,
        localStorage: { getItem: () => null, setItem: () => undefined },
        fetch: (url: string) => url === "/api/providers" ? new Promise((resolve, reject) => pending.push({ finish: (body, ok = true) => resolve({ ok, status: ok ? 200 : 503, json: async () => body }), reject })) : Promise.resolve({ ok: true, json: async () => ({ active: "embedding" }) }),
    };
    stateSetters(state, ["providers", "providersLoading", "providersLoaded", "providersError", "chatSel", "embedSel"]);
    const actions = runInNewContext(extract("../src/app/page.tsx", ["loadProviders"]), state) as { loadProviders: () => Promise<void> };
    const policy = () => runInNewContext(extract("../src/app/page.tsx", ["effectiveChatSel", "preferencesBlocked", "noFreeChatModel", "sendBlocked"]), { ...state }) as { noFreeChatModel: boolean; sendBlocked: boolean };
    return { state, actions, pending, policy };
}

test("failed provider discovery cannot masquerade as no configured free models, and retry recovers", async () => {
    const f = providerFixture();
    assert.equal(f.policy().noFreeChatModel, false); assert.equal(f.policy().sendBlocked, true);
    const failed = f.actions.loadProviders(); f.pending[0].finish({ error: "Unavailable" }, false); await failed;
    assert.equal(f.state.providersLoaded, false); assert.equal(f.state.providersLoading, false); assert.match(String(f.state.providersError), /Could not load/);
    assert.equal(f.policy().noFreeChatModel, false); assert.equal(f.policy().sendBlocked, true);
    const retry = f.actions.loadProviders(); f.pending[1].finish({ providers: [freeProvider], defaults: { chat: { providerId: "fixture", modelId: "free" } } }); await retry;
    assert.equal(f.state.providersLoaded, true); assert.equal(f.state.providersError, ""); assert.equal(f.state.chatSel, "fixture::free");
    assert.equal(f.policy().sendBlocked, false);
});

test("provider refresh failures retain known models and the selected model", async () => {
    const f = providerFixture();
    Object.assign(f.state, { providersLoaded: true, providers: [freeProvider], chatSel: "fixture::other" });
    const failed = f.actions.loadProviders(); f.pending[0].reject(new Error("Offline")); await failed;
    assert.equal((f.state.providers as unknown[])[0], freeProvider); assert.equal(f.state.chatSel, "fixture::other");
    assert.match(String(f.state.providersError), /Could not load/); assert.equal(f.policy().sendBlocked, false);
    const retry = f.actions.loadProviders(); f.pending[1].finish({ providers: [freeProvider], defaults: { chat: { providerId: "fixture", modelId: "free" } } }); await retry;
    assert.equal(f.state.chatSel, "fixture::other");
});

test("only successful provider discovery can confirm no free model is available", async () => {
    const f = providerFixture();
    const malformed = f.actions.loadProviders(); f.pending[0].finish({}); await malformed;
    assert.equal(f.state.providersLoaded, false); assert.equal(f.policy().noFreeChatModel, false);
    const empty = f.actions.loadProviders(); f.pending[1].finish({ providers: [] }); await empty;
    assert.equal(f.state.providersLoaded, true); assert.equal(f.policy().noFreeChatModel, true); assert.equal(f.policy().sendBlocked, true);
    f.state.knowledgeOnly = true; assert.equal(f.policy().sendBlocked, false);
});

test("a stale provider failure cannot undo successful newer discovery", async () => {
    const f = providerFixture(); const old = f.actions.loadProviders(), latest = f.actions.loadProviders();
    f.pending[1].finish({ providers: [freeProvider] }); await latest;
    f.pending[0].finish({ error: "Old failure" }, false); await old;
    assert.equal(f.state.providersLoaded, true); assert.equal(f.state.providersError, ""); assert.equal(f.state.providersLoading, false);
});

test("blocked browser preference storage does not turn valid discovery into a provider failure", async () => {
    const f = providerFixture(); f.state.localStorage = { getItem: () => { throw new Error("Blocked"); } };
    const request = f.actions.loadProviders(); f.pending[0].finish({ providers: [freeProvider] }); await request;
    assert.equal(f.state.providersLoaded, true); assert.equal(f.state.providersError, ""); assert.equal(f.policy().sendBlocked, false);
});


const dashboardSource = readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");
const dashboardTree = ts.createSourceFile("dashboard.tsx", dashboardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let fragmentEffect = "() => undefined";
function findFragmentEffect(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(dashboardTree) === "useEffect" && node.arguments[0]?.getText(dashboardTree).includes('"hashchange"')) fragmentEffect = node.arguments[0].getText(dashboardTree);
    ts.forEachChild(node, findFragmentEffect);
}
findFragmentEffect(dashboardTree);
function dashboardFragment(loading: boolean, hash = "#security") {
    const focused: string[] = [], scrolled: string[] = [];
    const attributes = new Map<string, string>();
    const listeners = new Map<string, () => void>();
    const location = { hash };
    const setup = runInNewContext(ts.transpileModule(`(${fragmentEffect});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
        loading,
        window: { location, addEventListener: (name: string, listener: () => void) => listeners.set(name, listener), removeEventListener: (name: string) => listeners.delete(name) },
        document: { getElementById: (id: string) => ({ setAttribute: (name: string, value: string) => attributes.set(`${id}:${name}`, value), focus: () => focused.push(id), scrollIntoView: () => scrolled.push(id) }) },
    }) as () => (() => void) | undefined;
    const cleanup = setup();
    return { focused, scrolled, attributes, listeners, location, cleanup };
}
test("Dashboard waits until async sections exist before following a fragment", () => {
    const before = dashboardFragment(true);
    assert.deepEqual(before.focused, []);
    assert.equal(before.listeners.size, 0);
    const ready = dashboardFragment(false);
    assert.deepEqual(ready.focused, ["security"]);
    assert.deepEqual(ready.scrolled, ["security"]);
    assert.equal(ready.attributes.get("security:tabindex"), "-1");
});
test("Dashboard responds to later allowed fragment changes and removes its listener", () => {
    const f = dashboardFragment(false, "#model-health");
    f.location.hash = "#agents";
    f.listeners.get("hashchange")?.();
    assert.deepEqual(f.focused, ["model-health", "agents"]);
    assert.deepEqual(f.scrolled, ["model-health", "agents"]);
    f.cleanup?.();
    assert.equal(f.listeners.size, 0);
});
test("Dashboard ignores missing and unrecognised fragment destinations", () => {
    for (const hash of ["", "#security-password", "#other", "#%73ecurity"]) {
        const f = dashboardFragment(false, hash);
        assert.deepEqual(f.focused, []);
        assert.deepEqual(f.scrolled, []);
        f.cleanup?.();
    }
});
