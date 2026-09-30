import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/app/api/council/[code]/integrator/route.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
test("integrator API explains a running-attempt refusal with409 rather than implying success", async () => {
    const calls: unknown[] = [];
    const loaded = { exports: {} as { POST: (request: NextRequest, context: { params: Promise<{ code: string }> }) => Promise<Response> } };
    runInNewContext(output, { exports: loaded.exports, module: loaded, console, require: (id: string) => {
        if (id === "@/lib/council/store") return { getSessionByCode: async () => ({ id: "session" }) };
        if (id === "@/lib/council/campaign") return { setCampaignIntegrator: async (args: unknown) => { calls.push(args); return { ok: false, reason: "attempt_running" }; } };
        return require(id);
    } });
    const response = await loaded.exports.POST(new NextRequest("http://localhost/api/council/CN-TEST/integrator", { method: "POST", body: JSON.stringify({ agentName: "reviewer" }), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ code: "CN-TEST" }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Assembly is running. Wait for this attempt to finish before delegating again." });
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ sessionId: "session", agentName: "reviewer" }]);
});
