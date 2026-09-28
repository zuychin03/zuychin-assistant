import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/app/research/workbench.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("workbench.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlerNames = new Set(["chooseSource", "chooseQuestion", "editEntry", "addSource", "editQuestion"]);
const handlers: string[] = [];
const dirtyExpressions: string[] = [];
const dirtyNames = new Set(["sourceLabelChanged", "savedEntry", "entryDraftChanged", "questionDraftChanged", "researchDraftChanged"]);
let newQuestion = "";
let editQuestion = "";

// Run the production handlers without adding a DOM runtime to the Node suites.
function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && handlerNames.has(node.name.text)) handlers.push(node.getText(tree));
    if (ts.isVariableDeclaration(node) && dirtyNames.has(node.name.getText(tree))) dirtyExpressions.push("const " + node.getText(tree) + ";");
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "button"
        && node.children.some(child => ts.isJsxText(child) && ["New question", "Edit question"].includes(child.text.trim()))) {
        const click = node.openingElement.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "onClick");
        if (click && ts.isJsxAttribute(click) && click.initializer && ts.isJsxExpression(click.initializer)) {
            const callback = click.initializer.expression?.getText(tree) ?? "";
            if (node.children.some(child => ts.isJsxText(child) && child.text.trim() === "New question")) newQuestion = callback;
            else editQuestion = callback;
        }
    }
    ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(handlers.length >= 4, "Research handlers must remain available to regression tests");
assert.ok(dirtyExpressions.length, "Research dirty state must remain testable");
assert.ok(editQuestion, "Research edit-question transition must remain testable");
assert.ok(newQuestion, "Research new-question transition must remain testable");
const compiled = ts.transpileModule([
    ...dirtyExpressions,
    ...handlers,
    "const startQuestion = " + newQuestion + ";",
    "const startEditQuestion = " + editQuestion + ";",
    "({ chooseSource, chooseQuestion, editEntry, addSource, startQuestion, startEditQuestion });",
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

interface Transitions {
    chooseSource: (id: string) => boolean;
    chooseQuestion: (id: string) => void;
    editEntry: (entry: { id: string; sourceId: string; text: string; kind: string; version: number }) => void;
    addSource: () => Promise<void>;
    startQuestion: () => void;
    startEditQuestion: () => void;
}
function setup({ accept = false, sourceTitle = "Unsaved title", entryDraft = null, questionDraft = null, savedEntries = [] }: { accept?: boolean; sourceTitle?: string; entryDraft?: Record<string, unknown> | null; questionDraft?: Record<string, unknown> | null; savedEntries?: Array<Record<string, unknown>> } = {}) {
    const changes: Array<[string, unknown]> = [];
    const prompts: string[] = [];
    const activeRef = { current: "question-a" };
    const sourceRequests = { current: new Map<string, string>() };
    const environment: Record<string, unknown> = {
        sourceId: "a", sourceTitle, selected: { title: "Saved title" },
        current: { question: { id: "question-a", projectId: "project-a", title: "Saved question", question: "Saved question text", status: "active", version: 1 }, entries: savedEntries, sources: [{ id: "a", title: "Saved title", version: 1 }, { id: "b", title: "Second title", version: 2 }] },
        index: { projects: [{ id: "project-a" }] }, entryDraft, questionDraft,
        documentId: "document-b", activeId: "question-a", activeRef, sourceRequests,
        window: { confirm: (message: string) => { prompts.push(message); return accept; } },
        crypto: { randomUUID: () => "draft-new" },
        request: async () => { changes.push(["request", null]); throw new Error("Unexpected request"); },
    };
    for (const name of ["setSourceId", "setSourceTitle", "setSourceVersion", "setActiveId", "setEntryDraft", "setQuestionDraft", "setError", "setNotice", "setConflict", "setView", "setBusy"]) {
        environment[name] = (value: unknown) => changes.push([name, value]);
    }
    const transitions = runInNewContext(compiled, environment) as Transitions;
    return { transitions, changes, prompts, activeRef, sourceRequests };
}

test("cancelling a source switch preserves its edited label and selection", () => {
    const f = setup();
    assert.equal(f.transitions.chooseSource("b"), false);
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 1);
});

test("reselecting the same source does not reset an edited label", () => {
    const f = setup();
    assert.equal(f.transitions.chooseSource("a"), true);
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 0);
});

test("accepting a source replacement updates identity, label and version together", () => {
    const f = setup({ accept: true });
    assert.equal(f.transitions.chooseSource("b"), true);
    assert.deepEqual(f.changes, [["setSourceId", "b"], ["setSourceTitle", "Second title"], ["setSourceVersion", 2]]);
});

test("a clean source label switches without an unnecessary confirmation", () => {
    const f = setup({ sourceTitle: "Saved title" });
    assert.equal(f.transitions.chooseSource("b"), true);
    assert.equal(f.prompts.length, 0);
});

test("cancelling a question switch leaves the current question and draft intact", () => {
    const f = setup();
    f.transitions.chooseQuestion("question-b");
    assert.deepEqual(f.changes, []);
    assert.equal(f.activeRef.current, "question-a");
});

test("editing another source's note cannot partially replace state after cancellation", () => {
    const f = setup();
    f.transitions.editEntry({ id: "entry-b", sourceId: "b", text: "Saved note", kind: "claim", version: 1 });
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 1);
});

test("cancelled source addition neither reserves a request nor submits it", async () => {
    const f = setup();
    await f.transitions.addSource();
    assert.deepEqual(f.changes, []);
    assert.equal(f.sourceRequests.current.size, 0);
    assert.equal(f.prompts.length, 1);
});

test("starting a new question also preserves the unsaved source label on cancellation", () => {
    const f = setup();
    f.transitions.startQuestion();
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 1);
});


const savedSource = { sourceTitle: "Saved title" };
const quoteDraft = { id: "entry-new", text: "", kind: "annotation", sourceId: "a", quote: "Carefully selected source evidence", startOffset: 10 };

test("question switches preserve a quote-only note draft on cancellation", () => {
    const f = setup({ ...savedSource, entryDraft: quoteDraft });
    f.transitions.chooseQuestion("question-b");
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 1);
});

test("starting a new question preserves a quote-only note draft on cancellation", () => {
    const f = setup({ ...savedSource, entryDraft: quoteDraft });
    f.transitions.startQuestion();
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 1);
});

test("a cleared existing note is still an unsaved edit", () => {
    const f = setup({ ...savedSource, entryDraft: { id: "entry-a", text: "", kind: "interpretation", sourceId: null }, savedEntries: [{ id: "entry-a", text: "Saved note", kind: "interpretation", sourceId: null }] });
    f.transitions.chooseQuestion("question-b");
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 1);
});

test("editing another note protects a quote-only draft", () => {
    const f = setup({ ...savedSource, entryDraft: quoteDraft });
    f.transitions.editEntry({ id: "entry-b", sourceId: "b", text: "Saved note", kind: "claim", version: 1 });
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 1);
});

test("reopening the current question editor preserves its edited content", () => {
    const f = setup({ ...savedSource, questionDraft: { id: "question-a", title: "Authored edit", question: "Authored question", version: 1 } });
    f.transitions.startEditQuestion();
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 0);
});

test("opening the saved question from a new authored question offers cancellation", () => {
    const f = setup({ ...savedSource, questionDraft: { id: "new-question", title: "New authored title", question: "", status: "active" } });
    f.transitions.startEditQuestion();
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 1);
});

test("accepting replacement opens the saved question", () => {
    const f = setup({ ...savedSource, accept: true, questionDraft: { id: "new-question", title: "New authored title", question: "", status: "active" } });
    f.transitions.startEditQuestion();
    assert.equal(f.prompts.length, 1);
    assert.equal((f.changes.find(([name]) => name === "setQuestionDraft")?.[1] as { id: string }).id, "question-a");
});

test("unchanged saved notes do not cause a discard warning", () => {
    const entry = { id: "entry-a", text: "Saved note", kind: "interpretation", sourceId: null };
    const f = setup({ ...savedSource, entryDraft: entry, savedEntries: [entry] });
    f.transitions.chooseQuestion("question-b");
    assert.equal(f.prompts.length, 0);
    assert.equal(f.activeRef.current, "question-b");
});

test("reselecting the current question preserves its drafts without prompting", () => {
    const f = setup({ ...savedSource, entryDraft: quoteDraft });
    f.transitions.chooseQuestion("question-a");
    assert.deepEqual(f.changes, []);
    assert.equal(f.prompts.length, 0);
});
