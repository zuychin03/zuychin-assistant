import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as evidenceModule from "../src/lib/council/execution-evidence.ts";

const require = createRequire(import.meta.url);
function load(relative: string, extras: Record<string, unknown> = {}) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const loaded = { exports: {} as Record<string, React.ComponentType<Record<string, unknown>>> };
    runInNewContext(output, { exports: loaded.exports, module: loaded, require: (id: string) => {
        if (id in extras) return extras[id];
        if (id === "@/lib/council/execution-evidence") return evidenceModule;
        if (id.endsWith(".module.css")) return { default: new Proxy({}, { get: (_target, key) => String(key) }), __esModule: true };
        if (id === "@/components/dropdown") return { Dropdown: () => null };
        return require(id);
    }, console, Date, Map });
    return loaded.exports;
}
const components = load("../src/app/council/execution-evidence.tsx");
const evidence = {
    executionId: "00000000-0000-4000-8000-000000000001", agentName: "reviewer", connectorKind: "acp", identityAssurance: "host_verified",
    provider: "fixture", adapterVersion: "1.2.3", requestedModel: "requested-model", effectiveModel: "observed-model",
    requestedReasoningEffort: "high", effectiveReasoningEffort: "medium", modelSource: "adapter_legacy_set_model",
    hostGeneration: "typescript-node", policyVersion: "typescript-node-v3-2026-09-30",
};

test("real evidence JSX shows both requested and observed values and honest acknowledgement", () => {
    const html = renderToStaticMarkup(createElement(components.ExecutionEvidence, { executionId: evidence.executionId, snapshot: evidence }));
    for (const text of ["<details", "<summary", "Requested model", "Effective model", "requested-model", "observed-model", "high", "medium", "1.2.3", "Selection acknowledged", "without independent model readback", "Host generation", "Policy version", "typescript-node-v3-2026-09-30"]) assert(html.includes(text), text);
});

test("a summary keeps its label and model apart in its text", () => {
    const html = renderToStaticMarkup(createElement(components.ExecutionEvidence, { executionId: evidence.executionId, snapshot: evidence, label: "Latest recorded run" }));
    assert(html.replace(/<[^>]+>/g, "").includes("Latest recorded run observed-model"));
});

test("real JSX keeps historical unknown and unavailable references distinct", () => {
    const unbound = renderToStaticMarkup(createElement(components.ExecutionEvidence, { records: [evidence], executionId: null }));
    const missing = renderToStaticMarkup(createElement(components.ExecutionEvidence, { records: [evidence], executionId: "missing" }));
    assert(unbound.includes("not recorded"));
    assert(missing.includes("evidence unavailable"));
    assert(!unbound.includes("observed-model"));
    assert(!missing.includes("observed-model"));
});

test("an unended execution is not presented as currently running", () => {
    const html = renderToStaticMarkup(createElement(components.ExecutionRecord, { record: { ...evidence, startedAt: "2026-09-30T00:00:00Z", endedAt: null, predecessorExecutionId: null }, label: "Latest recorded run" }));
    assert(html.includes("End not recorded"));
    assert(!html.includes("Running"));
});

test("historical execution policy fields render as unknown without applying today's policy", () => {
    const html = renderToStaticMarkup(createElement(components.ExecutionEvidence, { executionId: evidence.executionId, snapshot: { ...evidence, hostGeneration: null, policyVersion: null } }));
    assert(html.includes("Host generation</dt><dd>Not recorded"));
    assert(html.includes("Policy version</dt><dd>Not recorded"));
    assert(!html.includes("typescript-node-v3-2026-09-30"));
});
