import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { studyDraft } from "../src/lib/study/scheduler";
import { studySettingsChanged } from "../src/app/study/settings-draft";

const source = readFileSync(new URL("../src/app/study/page.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("study.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers: string[] = [];
const callbacks = new Map<string, string>();
let dirty = "";

function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && ["replaceCardDraft", "choosePassage"].includes(node.name.text)) handlers.push(node.getText(tree));
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useUnsavedChanges") dirty = node.arguments[0]?.getText(tree) ?? "";
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "Dropdown") {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const label = attributes.find(attribute => attribute.name.getText(tree) === "ariaLabel")?.initializer;
        const change = attributes.find(attribute => attribute.name.getText(tree) === "onChange")?.initializer;
        if (label && ts.isStringLiteral(label) && change && ts.isJsxExpression(change) && change.expression) callbacks.set(label.text, change.expression.getText(tree));
    }
    ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(handlers.length, 2);
assert.ok(dirty);
assert.ok(callbacks.has("Review deck"));
assert.ok(callbacks.has("Practice type"));
const compiled = ts.transpileModule([
    ...handlers,
    "const changeDeck = " + callbacks.get("Review deck") + ";",
    "const changeKind = " + callbacks.get("Practice type") + ";",
    "const isDirty = " + dirty + ";",
    "({ changeDeck, changeKind, choosePassage, isDirty });",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

interface Draft { id: string; deck: string; kind: string; prompt: string; answer: string; quote: string; startOffset: number }
interface Transitions {
    changeDeck: (deck: string) => void;
    changeKind: (kind: string) => void;
    choosePassage: (quote: string, startOffset: number) => void;
    isDirty: () => boolean;
}
function setup({ accept = false, response = "", reflection = "", draft = null, baseline = draft }: { accept?: boolean; response?: string; reflection?: string; draft?: Draft | null; baseline?: Draft | null } = {}) {
    const changes: Array<[string, unknown]> = [];
    const prompts: string[] = [];
    const draftBaseline = { current: baseline };
    const settings = { dailyLimit: 20, timezone: "Australia/Sydney", version: 1 };
    const environment: Record<string, unknown> = {
        attempt: { id: "card-a" }, response, reflection, pending: null, editing: null, editBaseline: { current: null },
        draft, draftBaseline, settings, settingsBaseline: { current: settings }, studySettingsChanged, studyDraft,
        documentId: "source-a", snapshot: { path: "source-a.md" }, report: { documents: [{ id: "source-a", title: "Saved source" }] },
        crypto: { randomUUID: () => "new-draft" },
        window: { confirm: (message: string) => { prompts.push(message); return accept; } },
        setDeck: (deck: string) => changes.push(["deck", deck]),
        clearAttempt: () => changes.push(["clearAttempt", null]),
        setDraft: (value: Draft) => { environment.draft = value; changes.push(["draft", value]); },
    };
    const transitions = runInNewContext(compiled, environment) as Transitions;
    return { transitions, changes, prompts, draftBaseline };
}

test("a reflection survives cancelling a deck switch after the answer was cleared", () => {
    const f = setup({ reflection: "Keep this correction" });
    f.transitions.changeDeck("Other deck");
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(f.changes, []);
});

test("accepting a reflection-only deck switch clears the old attempt", () => {
    const f = setup({ reflection: "Keep this correction", accept: true });
    f.transitions.changeDeck("Other deck");
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(f.changes, [["deck", "Other deck"], ["clearAttempt", null]]);
});

test("a clean review deck switch needs no discard warning", () => {
    const f = setup();
    f.transitions.changeDeck("Other deck");
    assert.equal(f.prompts.length, 0);
    assert.deepEqual(f.changes, [["deck", "Other deck"], ["clearAttempt", null]]);
});

const baseline: Draft = { id: "draft-a", deck: "Saved source", kind: "recall", ...studyDraft("recall", "An exact source passage of sufficient length.", "Saved source"), quote: "An exact source passage of sufficient length.", startOffset: 0 };

test("changing practice type preserves the dirty state of an authored deck", () => {
    const f = setup({ draft: { ...baseline, deck: "My authored deck" }, baseline });
    assert.equal(f.transitions.isDirty(), true);
    f.transitions.changeKind("explain");
    assert.equal(f.prompts.length, 0);
    assert.equal((f.changes[0][1] as Draft).deck, "My authored deck");
    assert.equal(f.transitions.isDirty(), true);
});

test("switching passage keeps a retained authored deck protected", () => {
    const f = setup({ accept: true, draft: { ...baseline, deck: "My authored deck" }, baseline });
    f.transitions.choosePassage("A different saved passage of sufficient length.", 100);
    assert.equal(f.prompts.length, 1);
    assert.equal((f.changes[0][1] as Draft).deck, "My authored deck");
    assert.equal(f.transitions.isDirty(), true);
});

test("cancelling a practice-type replacement preserves all authored card fields", () => {
    const draft = { ...baseline, prompt: "My authored question", answer: "My authored answer" };
    const f = setup({ draft, baseline });
    f.transitions.changeKind("explain");
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(f.changes, []);
    assert.equal(f.draftBaseline.current, baseline);
    assert.equal(f.transitions.isDirty(), true);
});

test("changing an untouched generated card does not create a false dirty flag", () => {
    const f = setup({ draft: baseline });
    f.transitions.changeKind("explain");
    assert.equal(f.prompts.length, 0);
    assert.equal(f.transitions.isDirty(), false);
});
