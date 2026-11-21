import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import ts from "typescript";
import * as evidence from "../src/lib/council/execution-evidence.ts";

const require = createRequire(import.meta.url);
const executionId = "00000000-0000-4000-8000-000000000001";
const page = { records: [], referencedRecords: [], nextCursor: null, historyStatus: "unavailable", referencesStatus: "unavailable" };
function load(relative: string, reader: Record<string, unknown>) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const loaded = { exports: {} as { GET: (req: NextRequest, context: { params: Promise<{ code: string }> }) => Promise<Response> } };
    runInNewContext(output, { exports: loaded.exports, module: loaded, console, require: (id: string) => {
        if (id === "@/lib/council/execution-evidence") return evidence;
        if (id === "@/lib/council/execution-reader") return reader;
        if (id === "@/lib/council/store") return {
            getSessionByCode: async (code: string) => ({ id: "session", code, status: "closed", pausedAt: null }),
            listParticipants: async () => [],
            readTranscript: async () => [{ seq: 1, executionId, body: "Keep the transcript visible" }, { seq: 2, executionId: null, body: "Old message" }],
        };
        if (id === "@/lib/council/online/store") return { latestSeatModels: async () => new Map(), readLease: async () => null };
        if (id === "@/lib/ai/providers") return { resolveModelKey: () => null };
        return require(id);
    } });
    return loaded.exports;
}

test("detail API preserves transcript on evidence errors and asks only for the bindings its messages reference", async () => {
    const calls: unknown[][] = [];
    const { GET } = load("../src/app/api/council/[code]/route.ts", { readExecutionEvidence: async (...args: unknown[]) => { calls.push(args); return page; } });
    const response = await GET(new NextRequest("http://localhost/api/council/CN-TEST"), { params: Promise.resolve({ code: "CN-TEST" }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.equal(body.messages[0].body, "Keep the transcript visible");
    assert.equal(body.messages[1].executionId, null);
    assert.equal(body.executions.historyStatus, "unavailable");
    assert.equal(body.online, null, "an agent council is never reported as online");
    assert.equal(body.campaign, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["session", { referencedIds: [executionId, null] }]]);
});

test("history API validates cursor before reading and reports unavailable reads with no-store", async () => {
    let calls = 0;
    const { GET } = load("../src/app/api/council/[code]/executions/route.ts", {
        parseExecutionCursor: (cursor: string) => { if (cursor === "invalid") throw new Error(); },
        readExecutionEvidence: async () => { calls++; return page; },
    });
    const invalid = await GET(new NextRequest("http://localhost/api/council/CN-TEST/executions?cursor=invalid"), { params: Promise.resolve({ code: "CN-TEST" }) });
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
    const response = await GET(new NextRequest("http://localhost/api/council/CN-TEST/executions"), { params: Promise.resolve({ code: "CN-TEST" }) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(calls, 1);
});
