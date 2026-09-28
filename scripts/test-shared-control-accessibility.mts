import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { nextModelOption } from "../src/app/home/model-picker.ts";

function source(path: string) {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function find(tree: ts.SourceFile, predicate: (node: ts.Node) => boolean) {
    let found: ts.Node | undefined;
    const visit = (node: ts.Node) => {
        if (!found && predicate(node)) found = node;
        if (!found) ts.forEachChild(node, visit);
    };
    visit(tree);
    assert(found, "Production handler was not found");
    return found;
}
function variable(tree: ts.SourceFile, name: string) {
    const node = find(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration;
    assert(node.initializer);
    return node.initializer.getText(tree);
}
function execute<T>(code: string, context: Record<string, unknown>): T {
    const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return runInNewContext(compiled, context) as T;
}
function keyEvent(key: string, shiftKey = false) {
    return {
        key, shiftKey, nativeEvent: { isComposing: false }, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
    };
}
const controls = source("../src/app/home/controls.tsx");
function picker(searchable: boolean) {
    const state = { open: true, focused: false, selected: "", active: "a" };
    const handle = execute<(event: ReturnType<typeof keyEvent>) => void>(`
        const closeMenu = ${variable(controls, "closeMenu")};
        const handleNavigation = ${variable(controls, "handleNavigation")};
        handleNavigation;
    `, {
        searchable, options: [{ value: "a" }, { value: "b" }], activeIndex: 0, activeOption: { value: "a" }, nextModelOption,
        setOpen: (value: boolean) => { state.open = value; },
        triggerRef: { current: { focus: () => { state.focused = true; } } },
        selectOption: (value: string) => { state.selected = value; },
        setActiveValue: (value: string) => { state.active = value; },
    });
    return { state, handle };
}
for (const searchable of [true, false]) for (const shift of [false, true]) test(`model picker ${searchable ? "search" : "list"} ${shift ? "Shift+Tab" : "Tab"} restores the trigger without trapping traversal`, () => {
    const f = picker(searchable), event = keyEvent("Tab", shift);
    f.handle(event);
    assert.equal(f.state.open, false);
    assert.equal(f.state.focused, true);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.stopped, false);
    assert.equal(f.state.selected, "");
});
test("model picker Escape remains local and arrows still navigate", () => {
    const f = picker(true);
    f.handle(keyEvent("ArrowDown"));
    assert.equal(f.state.active, "b");
    const event = keyEvent("Escape");
    f.handle(event);
    assert.equal(f.state.open, false);
    assert.equal(f.state.focused, true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
});

const home = source("../src/app/page.tsx");
const conversations = source("../src/app/home/conversation-list.tsx");
const menu = find(conversations, node => ts.isJsxOpeningElement(node) && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(conversations) === "role" && attribute.initializer?.getText(conversations) === '"menu"')) as ts.JsxOpeningElement;
const keyAttribute = menu.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(conversations) === "onKeyDown") as ts.JsxAttribute;
assert(keyAttribute.initializer && ts.isJsxExpression(keyAttribute.initializer) && keyAttribute.initializer.expression);
const menuKey = keyAttribute.initializer.expression.getText(conversations);
for (const shift of [false, true]) test(`closing a mobile drawer menu preserves ${shift ? "reverse traversal" : "the forward focus boundary"}`, () => {
    const document = { activeElement: null as unknown, querySelector: () => null };
    const first = { focus: () => { document.activeElement = first; }, getClientRects: () => [1] };
    const last = { focus: () => { document.activeElement = last; }, getClientRects: () => [1] };
    class Element { closest() { return {}; } }
    const event = { ...keyEvent("Tab", shift), target: new Element() };
    const handlers = execute<{ menu: (input: typeof event) => void; drawer: (input: typeof event) => void }>(`
        const closeMenu = ${variable(conversations, "closeMenu")};
        ({ menu: ${menuKey}, drawer: ${variable(home, "onKeyDown")} });
    `, {
        document, Element, panel: { querySelectorAll: () => [first, last] },
        setMenuFor: () => undefined, setMoveFor: () => undefined, menuAnchorRef: { current: last },
        setSidebarOpen: () => undefined, setNotesOpen: () => undefined,
    });
    handlers.menu(event);
    handlers.drawer(event);
    assert.equal(document.activeElement, shift ? last : first);
    assert.equal(event.defaultPrevented, !shift);
});

const council = source("../src/app/council/page.tsx");
const transcriptEffect = find(council, node => ts.isCallExpression(node) && node.expression.getText(council) === "useEffect" && node.arguments[0]?.getText(council).includes('lastSeqRef.current = last')) as ts.CallExpression;
for (const reduced of [false, true]) test(`chat and transcript scrolling respect reduced motion ${reduced}`, () => {
    const calls: { behavior: string; block?: string }[] = [];
    const scrollRef = { current: { scrollIntoView: (options: { behavior: string; block?: string }) => calls.push(options) } };
    const window = { matchMedia: (query: string) => { assert.equal(query, "(prefers-reduced-motion: reduce)"); return { matches: reduced }; } };
    execute<() => void>(`(${variable(home, "scrollToBottom")});`, { messagesEndRef: scrollRef, window })();
    execute<() => void>(`(${transcriptEffect.arguments[0].getText(council)});`, { transcriptEnd: scrollRef, window, detail: { messages: [{ seq: 2 }] }, lastSeqRef: { current: 1 } })();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.behavior), [reduced ? "auto" : "smooth", reduced ? "auto" : "smooth"]);
    assert.equal(calls[1].block, "end");
});


const modalKeys: string[] = [];
let focusHelper = "";
function visitModal(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "containDialogFocus") focusHelper = node.getText(controls);
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(controls) === "dialog") {
        const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(controls) === "onKeyDown") as ts.JsxAttribute | undefined;
        modalKeys.push(attribute?.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression ? attribute.initializer.expression.getText(controls) : "() => undefined");
    }
    ts.forEachChild(node, visitModal);
}
visitModal(controls);
assert.equal(modalKeys.length, 2);
for (const [index, label] of ["Model details", "Confirmation"].entries()) {
    function dialogFixture() {
        const document = { activeElement: null as unknown };
        const first = { tabIndex: 0, focus: () => { document.activeElement = first; }, closest: () => null, getClientRects: () => [1] };
        const last = { tabIndex: 0, focus: () => { document.activeElement = last; }, closest: () => null, getClientRects: () => [1] };
        const dialog = { querySelectorAll: () => [first, last], focus: () => { document.activeElement = dialog; } };
        const handle = execute<(input: ReturnType<typeof keyEvent> & { currentTarget: typeof dialog }) => void>(`${focusHelper}\n(${modalKeys[index]});`, { document });
        return { document, first, last, dialog, handle };
    }
    for (const shift of [false, true]) test(`${label} wraps ${shift ? "reverse" : "forward"} Tab at its boundary`, () => {
        const f = dialogFixture();
        f.document.activeElement = shift ? f.first : f.last;
        const event = { ...keyEvent("Tab", shift), currentTarget: f.dialog };
        f.handle(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(f.document.activeElement, shift ? f.last : f.first);
    });
    test(`${label} keeps Tab inside its noninteractive progress view`, () => {
        const f = dialogFixture();
        f.dialog.querySelectorAll = () => [];
        f.document.activeElement = f.dialog;
        const event = { ...keyEvent("Tab"), currentTarget: f.dialog };
        f.handle(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(f.document.activeElement, f.dialog);
    });
    test(`${label} preserves interior traversal and a child control's handled key`, () => {
        const f = dialogFixture();
        f.document.activeElement = f.first;
        const interior = { ...keyEvent("Tab"), currentTarget: f.dialog };
        f.handle(interior);
        assert.equal(interior.defaultPrevented, false);
        const handled = { ...keyEvent("Tab", true), currentTarget: f.dialog, defaultPrevented: true };
        f.handle(handled);
        assert.equal(f.document.activeElement, f.first);
    });
}
