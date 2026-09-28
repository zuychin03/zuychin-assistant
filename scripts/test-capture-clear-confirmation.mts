import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/app/capture/page.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("capture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["action", "requestOfflineClear", "confirmOfflineClear"]);
const handlers: string[] = [];
let cancel = "";
let confirm = "";
let confirmationError = "undefined";
function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) handlers.push(node.getText(tree));
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "ConfirmModal") {
        const confirmAttribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(tree) === "onConfirm");
        if (confirmAttribute && ts.isJsxAttribute(confirmAttribute) && confirmAttribute.initializer && ts.isJsxExpression(confirmAttribute.initializer)) confirm = confirmAttribute.initializer.expression?.getText(tree) ?? "";
        const error = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(tree) === "error");
        if (error && ts.isJsxAttribute(error) && error.initializer && ts.isJsxExpression(error.initializer)) confirmationError = error.initializer.expression?.getText(tree) ?? "undefined";
        const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(tree) === "onCancel");
        if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) cancel = attribute.initializer.expression?.getText(tree) ?? "";
    }
    ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(handlers.length, names.size);
assert(cancel, "The clear confirmation must have a cancellation handler");
const code = ts.transpileModule(handlers.join("\n") + "\nconst cancelClear = " + cancel + "; const submitClear = " + confirm + "; const visibleError = () => " + confirmationError + "; ({ requestOfflineClear, confirmOfflineClear, cancelClear, submitClear, visibleError });", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
interface Handlers { requestOfflineClear: () => void; confirmOfflineClear: () => Promise<void>; cancelClear: () => void; visibleError: () => string | undefined; submitClear: () => void | Promise<void> }
function fixture() {
    const calls: string[] = [];
    const state: Record<string, unknown> = {
        busy: "", offline: { enabled: true, epoch: "current-account" }, clearRequest: null,
        locked: { current: false }, active: { current: true }, notice: "", error: "",
        message: (error: Error) => error.message,
        clearConfirmedOfflinePrivateData: async (epoch: string) => { calls.push(epoch); },
    };
    for (const [setter, key] of [["setClearRequest", "clearRequest"], ["setBusy", "busy"], ["setNotice", "notice"], ["setError", "error"]]) state[setter] = (value: unknown) => { state[key] = value; };
    return { handlers: vm.runInNewContext(code, state) as Handlers, state, calls };
}

test("opening and cancelling the confirmation cannot clear local data", async () => {
    const f = fixture();
    f.handlers.requestOfflineClear();
    assert.equal(JSON.stringify(f.state.clearRequest), '{"epoch":"current-account"}');
    assert.deepEqual(f.calls, []);
    f.handlers.cancelClear();
    await f.handlers.confirmOfflineClear();
    assert.equal(f.state.clearRequest, null);
    assert.deepEqual(f.calls, []);
});

test("only confirmation clears the captured account epoch", async () => {
    const f = fixture();
    f.handlers.requestOfflineClear();
    await f.handlers.confirmOfflineClear();
    assert.deepEqual(f.calls, ["current-account"]);
    assert.equal(f.state.clearRequest, null);
    assert.match(String(f.state.notice), /Reload the inbox/);
});

test("busy and disabled offline states do not open a destructive confirmation", () => {
    for (const patch of [{ busy: "sync" }, { offline: { enabled: false, epoch: "current-account" } }, { offline: undefined }]) {
        const f = fixture(); Object.assign(f.state, patch);
        f.handlers.requestOfflineClear();
        assert.equal(f.state.clearRequest, null);
        assert.deepEqual(f.calls, []);
    }
});

test("an epoch change fails visibly without reporting successful clearance", async () => {
    const f = fixture();
    f.handlers.requestOfflineClear();
    f.state.offline = { enabled: true, epoch: "new-account" };
    f.state.clearConfirmedOfflinePrivateData = async (epoch: string) => { assert.equal(epoch, "current-account"); throw new Error("The account changed while clearing."); };
    await f.handlers.confirmOfflineClear();
    assert.match(String(f.state.error), /account changed/);
    assert.equal(f.state.notice, "");
    assert.equal(f.state.busy, "");
});

test("repeated confirmation cannot start concurrent clears", async () => {
    const f = fixture(); let release: (() => void) | undefined;
    f.state.clearConfirmedOfflinePrivateData = (epoch: string) => { f.calls.push(epoch); return new Promise<void>(resolve => { release = resolve; }); };
    f.handlers.requestOfflineClear();
    const first = f.handlers.confirmOfflineClear();
    await f.handlers.confirmOfflineClear();
    assert.deepEqual(f.calls, ["current-account"]);
    assert(release); release(); await first;
});

interface DialogNode { type: unknown; props: Record<string, unknown>; children: unknown[] }
const controls = readFileSync(new URL("../src/app/home/controls.tsx", import.meta.url), "utf8");
const controlsTree = ts.createSourceFile("controls.tsx", controls, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const modalFunctions = controlsTree.statements.filter(node => ts.isFunctionDeclaration(node) && ["containDialogFocus", "ConfirmModal"].includes(node.name?.text ?? ""));
assert.equal(modalFunctions.length, 2, "The production confirmation and focus handler must remain available for rendering checks");
const modalCode = ts.transpileModule(modalFunctions.map(node => node.getText(controlsTree).replace(/^export /, "")).join("\n") + "\nConfirmModal;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "element" },
}).outputText;
function renderConfirmation(error?: string, onConfirm: () => void | Promise<void> = () => {}) {
    const render = vm.runInNewContext(modalCode, {
        element: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): DialogNode => ({ type, props: props ?? {}, children }),
        useRef: (value: unknown) => ({ current: value }), useState: (initial: () => unknown) => [initial()], useEffect: () => {}, useId: () => "dialog-id",
        controlStyles: { modelDialog: "dialog", control: "control" }, styles: { iconBtn: {} }, modal: { card: {}, header: {}, title: {}, desc: {} },
        confirmRow: {}, confirmCancelBtn: {}, confirmDangerBtn: {}, X: "icon",
    }) as (props: Record<string, unknown>) => DialogNode;
    return render({ title: "Clear private offline data?", body: "The captured account will be cleared.", confirmLabel: "Clear offline data", error, onConfirm, onCancel() {} });
}
function descendants(node: DialogNode): DialogNode[] {
    return [node, ...node.children.flat().filter((value): value is DialogNode => Boolean(value && typeof value === "object" && "children" in value)).flatMap(descendants)];
}

test("opening a fresh clear confirmation removes an unrelated old error", () => {
    const f = fixture();
    f.state.error = "An earlier download failed";
    f.handlers.requestOfflineClear();
    assert.equal(f.state.error, "");
    assert.equal(f.handlers.visibleError(), "");
});

test("failed clearance renders an alert inside the live confirmation and permits retry", async () => {
    const f = fixture();
    f.state.source = { title: "Unsaved capture", text: "Keep this draft" };
    f.state.note = "Unqueued note";
    f.handlers.requestOfflineClear();
    const originalRequest = f.state.clearRequest;
    let attempts = 0;
    f.state.clearConfirmedOfflinePrivateData = async () => { attempts++; if (attempts === 1) throw new Error("Offline storage is unavailable. Retry safely."); };
    await f.handlers.confirmOfflineClear();
    assert.equal(f.state.clearRequest, originalRequest);
    assert.equal(f.state.busy, "");
    assert.equal((f.state.locked as { current: boolean }).current, false);
    assert.equal(f.state.note, "Unqueued note");
    assert.deepEqual(f.state.source, { title: "Unsaved capture", text: "Keep this draft" });
    const dialog = renderConfirmation(f.handlers.visibleError());
    assert.equal(dialog.type, "dialog");
    const alert = descendants(dialog).find(node => node.props.role === "alert");
    assert(alert, "The failure must be announced inside the modal, not only on the inert page");
    assert.deepEqual(alert.children, ["Offline storage is unavailable. Retry safely."]);
    await f.handlers.confirmOfflineClear();
    assert.equal(attempts, 2);
    assert.equal(f.state.clearRequest, null);
    assert.equal(f.state.error, "");
});

test("a failed clear can be cancelled without deleting drafts", async () => {
    const f = fixture();
    f.state.note = "Unqueued note";
    f.handlers.requestOfflineClear();
    f.state.clearConfirmedOfflinePrivateData = async () => { throw new Error("Storage unavailable"); };
    await f.handlers.confirmOfflineClear();
    f.handlers.cancelClear();
    assert.equal(f.state.clearRequest, null);
    assert.equal(f.state.note, "Unqueued note");
    assert.equal(f.state.error, "Storage unavailable");
});

test("confirmations without an error do not render an empty alert", () => {
    assert.equal(descendants(renderConfirmation()).some(node => node.props.role === "alert"), false);
});

test("an immediately rejected clear remains retryable when React batches both busy updates", async () => {
    const f = fixture();
    f.handlers.requestOfflineClear();
    let attempts = 0;
    f.state.clearConfirmedOfflinePrivateData = async () => { attempts++; throw new Error("Storage unavailable"); };
    const dialog = renderConfirmation(undefined, f.handlers.submitClear);
    const confirmButton = descendants(dialog).find(node => node.type === "button" && node.children.includes("Clear offline data"));
    assert(confirmButton);
    const confirm = confirmButton.props.onClick as () => Promise<void>;
    await confirm();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.error, "Storage unavailable");
    assert.equal(f.state.busy, "");
    await confirm();
    assert.equal(attempts, 2, "The same visible dialog must accept retry without observing an intermediate busy render");
    assert.notEqual(f.state.clearRequest, null);
});
