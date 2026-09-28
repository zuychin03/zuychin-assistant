import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

type Mutation = "savePage" | "deletePage" | "deleteLink" | "linkOne" | "linkSelectedSuggestions";
interface RequestStub {
    url: string; method: string; body?: string;
    resolve: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
}

// Execute the production closures without mounting the WebGL scene or using live services.
function graph(initial: Record<string, unknown> = {}) {
    const source = readFileSync(new URL("../src/app/graph/page.tsx", import.meta.url), "utf8");
    const file = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "GraphPage");
    assert(component && ts.isFunctionDeclaration(component) && component.body);
    const names = ["mutationLock", "patch", "openNode", "closeSelection", "savePage", "deletePage", "deleteLink", "createLink", "linkOne", "linkSelectedSuggestions"];
    const statements = component.body.statements.filter(statement => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)));
    assert.equal(statements.length, names.length);
    const compiled = ts.transpileModule(`${statements.map(statement => statement.getText(file)).join("\n")}
        exports.handlers = { savePage, deletePage, deleteLink, linkOne, linkSelectedSuggestions, openNode, closeSelection };`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const requests: RequestStub[] = [], messages: string[] = [];
    const state: Record<string, unknown> = {
        selected: { type: "node", id: "a.md" }, busy: null, confirming: "delete", editMode: true,
        data: { nodes: [{ id: "a.md" }, { id: "b.md" }], edges: [], suggestions: [] },
        pageContents: { "a.md": "Base" }, selectedSuggestions: new Set(["b.md"]),
        suggestions: [{ target: "b.md" }], linkQuery: "B", linkLabel: "related", linkTargetId: "b.md",
        editText: "Draft", localRoot: null, routeFrom: null, routeTo: null,
        ...initial,
    };
    const exportsObject = {} as { handlers: Record<Mutation, (...args: string[]) => Promise<void>> & { openNode(id: string): void; closeSelection(): void } };
    const context: Record<string, unknown> = {
        ...state, exports: exportsObject, useRef: (value: unknown) => ({ current: value }), useCallback: (value: unknown) => value,
        draft: { base: "Base", saved: () => undefined }, editTextRef: { current: "Draft" }, selectedRef: { current: state.selected },
        nodeCache: { current: new Map() }, linkCache: { current: new Map() }, cosmosRef: { current: null },
        fetchGraph: async () => undefined, showToast: (message: string) => messages.push(message),
        fetch: (url: string, init?: { method?: string; body?: string }) => new Promise(resolve => requests.push({ url, method: init?.method ?? "GET", body: init?.body, resolve })),
        Set, Map, Error,
    };
    for (const key of [...Object.keys(state), "controlsRequested", "focusedSection", "dock"]) {
        context[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value: unknown) => {
            state[key] = typeof value === "function" ? value(state[key]) : value;
            context[key] = state[key];
        };
    }
    vm.runInNewContext(compiled, context);
    const invoke = (name: Mutation) => {
        context.selected = name === "deleteLink" ? { type: "link", link: { source: "a.md", target: "b.md" } } : state.selected;
        return exportsObject.handlers[name]("a.md", "b.md", "related");
    };
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const respond = async (index: number, data: unknown, ok = true) => {
        assert(requests[index], `Missing request ${index}`);
        requests[index].resolve({ ok, status: ok ? 200 : 500, json: async () => data });
        await flush();
    };
    return { ...exportsObject.handlers, invoke, state, context, requests, messages, respond };
}

const mutations: Mutation[] = ["savePage", "deletePage", "deleteLink", "linkOne", "linkSelectedSuggestions"];
for (const mutation of mutations) test(`${mutation} rejects overlapping graph mutations before a render and unlocks after failure`, async () => {
    const ui = graph();
    const pending = ui.invoke(mutation);
    assert.equal(ui.requests.length, 1);
    const busy = ui.state.busy;
    for (const other of mutations) void ui.invoke(other);
    assert.equal(ui.requests.length, 1, "Only the first action may send a request");
    assert.equal(ui.state.busy, busy, "A rejected action must not replace the active pending state");
    ui.openNode("b.md");
    ui.closeSelection();
    assert.deepEqual(ui.state.selected, { type: "node", id: "a.md" });
    await ui.respond(0, { error: "Synthetic failure" }, false);
    await pending;
    assert.equal(ui.state.busy, null);
    assert(ui.messages.some(message => message.includes("Synthetic failure")));
    assert.equal(ui.state.editText, "Draft");
    assert.equal(ui.state.linkLabel, "related");
    const retry = ui.invoke(mutation);
    assert.equal(ui.requests.length, 2, "Failure must release the lock for retry");
    await ui.respond(1, { error: "Synthetic retry failure" }, false);
    await retry;
    ui.closeSelection();
    assert.equal(ui.state.selected, null);
});

test("save retains its lock through the conflict check, write and saved-page reload", async () => {
    const ui = graph();
    const pending = ui.invoke("savePage");
    await ui.respond(0, { markdown: "Base" });
    assert.equal(ui.requests[1].method, "PUT");
    assert.deepEqual(JSON.parse(ui.requests[1].body!), { path: "a.md", markdown: "Draft", expectedMarkdown: "Base" });
    void ui.invoke("deletePage");
    assert.equal(ui.requests.length, 2);
    await ui.respond(1, {});
    assert.equal(ui.requests[2].method, "GET");
    void ui.invoke("linkOne");
    assert.equal(ui.requests.length, 3);
    await ui.respond(2, { markdown: "Draft" });
    await pending;
    assert.equal(ui.state.busy, null);
    const removal = ui.invoke("deletePage");
    assert.equal(ui.requests[3].method, "DELETE");
    await ui.respond(3, { error: "Synthetic failure" }, false);
    await removal;
});

test("batch linking holds one lock across sequential requests", async () => {
    const ui = graph({ selectedSuggestions: new Set(["b.md", "c.md"]) });
    const pending = ui.invoke("linkSelectedSuggestions");
    await ui.respond(0, {});
    assert.equal(ui.requests.length, 2);
    assert.equal(JSON.parse(ui.requests[1].body!).target, "c.md");
    void ui.invoke("deletePage");
    void ui.invoke("linkOne");
    assert.equal(ui.requests.length, 2);
    await ui.respond(1, {});
    await pending;
    assert.equal(ui.state.busy, null);
    assert(ui.messages.includes("Linked 2 of 2 pages."));
});

for (const success of [[false, false], [true, false], [false, true]]) test(`batch results ${success.join("/")} preserve failed selections for direct retry`, async () => {
    const targets = ["b.md", "c.md"];
    const ui = graph({ selectedSuggestions: new Set(targets), suggestions: targets.map(target => ({ target })) });
    const pending = ui.invoke("linkSelectedSuggestions");
    for (let index = 0; index < targets.length; index++) {
        await ui.respond(index, success[index] ? {} : { error: "Synthetic unavailable" }, success[index]);
    }
    await pending;
    const failed = targets.filter((_target, index) => !success[index]);
    assert.deepEqual(Array.from(ui.state.selectedSuggestions as Set<string>), failed);
    assert.deepEqual(Array.from(ui.state.suggestions as { target: string }[], item => item.target), failed);
    assert.equal(ui.state.linkLabel, "related");
    assert.equal(ui.messages.length, 1, "One final result must preserve the failure reason");
    assert.match(ui.messages[0], /Synthetic unavailable/);
    assert.match(ui.messages[0], /selected for retry/);
    assert.match(ui.messages[0], success.some(Boolean) ? /Linked 1 of 2 pages/ : /No pages linked/);
    const retry = ui.invoke("linkSelectedSuggestions");
    assert.equal(ui.requests.length, 3, "Retry uses the remaining selection without rebuilding it");
    for (let index = 0; index < failed.length; index++) {
        assert.equal(JSON.parse(ui.requests[2 + index].body!).target, failed[index]);
        await ui.respond(2 + index, {});
    }
    await retry;
    assert.equal(ui.requests.length, targets.length + failed.length, "Successful targets are not sent again");
    assert.equal((ui.state.selectedSuggestions as Set<string>).size, 0);
    assert.equal((ui.state.suggestions as unknown[]).length, 0);
    assert.equal(ui.state.busy, null);
});

interface Element { type: string; props: Record<string, unknown> & { children?: unknown } }
function panel(overrides: Record<string, unknown>, connection = false) {
    const source = readFileSync(new URL("../src/app/graph/panels/page-panel.tsx", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const exportsObject = {} as { default(props: Record<string, unknown>): Element; LinkPanel(props: Record<string, unknown>): Element };
    const element = (type: string, props: Element["props"]) => ({ type, props });
    vm.runInNewContext(compiled, {
        exports: exportsObject,
        require(name: string) {
            if (name === "react") return { useEffect: () => undefined, useRef: () => ({ current: null }), useState: () => [false, () => undefined], useMemo: (value: () => unknown) => value() };
            if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
            if (name === "lucide-react") return new Proxy({}, { get: (_target, key) => key });
            if (name.endsWith("workspace-link")) return { WorkspaceLink: "Link" };
            if (name.endsWith("palette")) return { CATEGORY_COLORS: {}, COSMOS: {}, HEALTH_COLORS: {}, HEALTH_LABELS: {} };
            if (name.endsWith("styles")) return { styles: {} };
            if (name.endsWith("model")) return { displayMarkdown: (value: string) => value, humanizePath: (value: string) => value };
            if (name.endsWith("sections")) return { documentHeadings: () => [] };
            if (name.endsWith("ui")) return { Badge: "Badge", PanelShell: "PanelShell" };
            if (name.endsWith("document-navigation") || name === "remark-gfm") return {};
            if (name === "react-markdown") return { default: "Markdown" };
            throw new Error(`Unmocked panel import: ${name}`);
        },
    });
    const props = {
        node: { id: "a.md", title: "A", category: "notes", health: [], words: 4, links: 1, centrality: 1 },
        source: "a.md", target: "b.md", kind: "real", markdown: "Base", editMode: true, editText: "Draft", draftDirty: true,
        draftPersisted: true, libraryHref: "/knowledge?path=a.md", busy: null, confirming: "delete",
        suggestions: [{ target: "b.md", similarity: 0.8 }], selectedSuggestions: new Set(["b.md"]),
        linkQuery: "B", linkLabel: "related", linkTargetId: "b.md", linkTargets: [], titleOf: (value: string) => value,
        ...overrides,
    };
    const tree = connection ? exportsObject.LinkPanel(props) : exportsObject.default(props);
    const all = (node: unknown): Element[] => {
        if (!node || typeof node !== "object") return [];
        if (Array.isArray(node)) return node.flatMap(all);
        const current = node as Element;
        return [current, ...all(current.props?.children), ...all(current.props?.aside)];
    };
    const text = (node: unknown): string => {
        if (node == null || typeof node === "boolean") return "";
        if (Array.isArray(node)) return node.map(text).join(" ");
        return typeof node === "object" ? text((node as Element).props?.children) : String(node);
    };
    const controls = all(tree);
    const find = (predicate: (element: Element) => boolean) => { const match = controls.find(predicate); assert(match); return match; };
    const button = (label: string) => find(node => node.type === "button" && text(node).replace(/\s+/g, " ").trim() === label);
    return { find, button, controls };
}

for (const busy of ["save", "delete", "link", "unlink"]) test(`page controls protect pending ${busy} without blocking read-only route choices`, () => {
    const ui = panel({ busy });
    for (const label of ["Save", "Reader", "Confirm delete", "Keep", "Discard draft", "System", "Link selected ( 1 )", "Link to b.md", "Cancel"]) {
        assert.equal(ui.button(label).props.disabled, true, label);
    }
    assert.equal(ui.find(node => node.props["aria-label"] === "Close page").props.disabled, true);
    assert.equal(ui.find(node => node.props["aria-label"] === "Link b.md").props.disabled, true);
    assert.equal(ui.find(node => node.props["aria-label"] === "Page markdown").props.readOnly, true);
    for (const input of ui.controls.filter(node => node.type === "input")) assert.equal(input.props.disabled, true);
    for (const label of ["From", "To"]) assert(!ui.button(label).props.disabled);
    const library = ui.find(node => node.type === "Link");
    assert.equal(library.props["aria-disabled"], true);
    let prevented = false;
    (library.props.onClick as (event: { preventDefault(): void }) => void)({ preventDefault: () => { prevented = true; } });
    assert(prevented);
    const idle = panel({ busy: null });
    assert.equal(idle.button("Save").props.disabled, false);
    assert.equal(idle.find(node => node.props["aria-label"] === "Page markdown").props.readOnly, false);
});

test("connection close, unlink and accept remain disabled during any graph mutation", () => {
    for (const busy of ["save", "delete", "link", "unlink"]) {
        const real = panel({ busy, confirming: "unlink" }, true);
        assert.equal(real.button("Confirm unlink").props.disabled, true);
        assert.equal(real.button("Keep").props.disabled, true);
        assert.equal(real.find(node => node.props["aria-label"] === "Close connection").props.disabled, true);
        const suggestion = panel({ busy, kind: "suggestion" }, true);
        assert.equal(suggestion.button("Make it real").props.disabled, true);
    }
});

test("page metadata formats saved dates consistently and handles invalid values without changing them", () => {
    for (const [updated, expected] of [
        ["2026-09-28", "28/09/2026"],
        ["2026-09-28T23:30:00.000Z", "28/09/2026"],
        ["not-a-date", "Unknown date"],
    ]) {
        const node = { id: "a.md", title: "A", category: "notes", health: [], words: 4, links: 1, centrality: 1, updated };
        const ui = panel({ node });
        const label = ui.find(element => element.type === "span" && Array.isArray(element.props.children) && element.props.children[0] === "Updated ");
        assert.equal((label.props.children as string[]).join(""), `Updated ${expected}`);
        assert.equal(node.updated, updated);
    }
});
