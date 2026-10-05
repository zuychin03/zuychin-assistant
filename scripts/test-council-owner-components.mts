import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as owner from "../src/lib/council/owner-evidence.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/app/council/owner-merge-package.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const loaded = { exports: {} as { AttemptReview: React.ComponentType<Record<string, unknown>> } };
runInNewContext(output, { exports: loaded.exports, module: loaded, Date, Set, require: (id: string) => {
    if (id === "@/lib/council/owner-evidence") return owner;
    if (id.endsWith(".module.css")) return { default: new Proxy({}, { get: (_target, key) => String(key) }), __esModule: true };
    if (id === "@/components/dropdown") return { Dropdown: () => null };
    if (id === "./execution-evidence") return { ExecutionEvidence: () => null };
    return require(id);
} });
const id = "00000000-0000-4000-8000-000000000001";
const attempt = { attemptId: id, attemptNumber: 1, status: "verified", mode: "host", baseBranch: "main", baseSha: "a".repeat(40), tipSha: "b".repeat(40), manifestHash: "c".repeat(64), startedAt: "2026-09-30T00:00:00Z", decision: "Keep the recorded owner decision", openQuestions: ["Check the mobile result"], manifest: { items: [] }, evidence: null, evidenceStatus: "not_recorded" };
const render = (patch: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(loaded.exports.AttemptReview, { code: "CN-TEST", attempt: { ...attempt, ...patch } }));

test("captured decision and questions remain reviewable when terminal receipts are missing", () => {
    const html = render();
    assert(html.includes("Keep the recorded owner decision"));
    assert(html.includes("Check the mobile result"));
    assert(html.includes("were not recorded"));
});
test("comparison requires a verified attempt and valid literal SHAs", () => {
    assert(render().includes(`git diff ${attempt.baseSha} ${attempt.tipSha} --`));
    assert(!render({ status: "failed" }).includes("Copy comparison command"));
    assert(!render({ tipSha: "main;whoami" }).includes("Copy comparison command"));
});
test("accepted commit counts read naturally", () => {
    const item = { itemId: "task", sequence: 1, agentName: "reviewer", commitSha: "d".repeat(40), acceptedExecutionId: null, executionEvidence: null, verificationRunId: id };
    assert(render({ manifest: { items: [item] } }).includes(">1 task<"));
    assert(render({ manifest: { items: [item, { ...item, itemId: "second", sequence: 2 }] } }).includes(">2 tasks<"));
});
test("protected refs present only after integration remain visible", () => {
    const html = render({ evidence: { receipts: [], changedPaths: [], diffSummary: null, protectedRefs: { before: {}, after: { "refs/heads/new": attempt.tipSha } }, conflictNotes: null, manualChecks: null } });
    assert(html.includes("refs/heads/new"));
    assert(html.includes("not observed"));
});
