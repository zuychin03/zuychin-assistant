import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path: string, reader: Record<string, unknown>, session: unknown = { id: "session" }) {
    const source = readFileSync(new URL(`../src/app/api/council/[code]/integration-attempts/${path}route.ts`, import.meta.url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const loaded = { exports: {} as { GET: (req: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response> } };
    runInNewContext(output, { exports: loaded.exports, module: loaded, console, require: (id: string) => {
        if (id === "@/lib/council/owner-evidence-reader") return reader;
        if (id === "@/lib/council/store") return { getSessionByCode: async () => session };
        return require(id);
    } });
    return loaded.exports.GET;
}
const context = { params: Promise.resolve({ code: "CN-TEST", attemptId: "attempt", runId: "run" }) };
const request = (query = "") => new NextRequest(`http://localhost/api/council/CN-TEST/integration-attempts${query}`);

test("attempt history validates cursors before reads and all result states are private no-store", async () => {
    let calls = 0;
    const GET = load("", { listOwnerAttempts: async () => { calls++; return { status: "available", attempts: [], nextCursor: null }; } });
    for (const cursor of ["0", "-1", "1.5", "1%0A", "9007199254740992"]) {
        const response = await GET(request(`?cursor=${cursor}`), context);
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    assert.equal(calls, 0);
    assert.equal((await GET(request(), context)).status, 200);
    assert.equal(calls, 1);
    const missing = await load("", {}, null)(request(), context);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "private, no-store");
});

test("detail and exact verification routes preserve missing versus unavailable without mutations", async () => {
    for (const [path, name, expectedArgs] of [["[attemptId]/", "readOwnerAttempt", ["session", "attempt"]], ["[attemptId]/verification/[runId]/", "readOwnerVerification", ["session", "attempt", "run"]]] as const) {
        for (const [status, http] of [["available", 200], ["not_found", 404], ["unavailable", 503]] as const) {
            const GET = load(path, { [name]: async (...args: unknown[]) => { assert.deepEqual(args, expectedArgs); return { status }; } });
            const response = await GET(request(), context);
            assert.equal(response.status, http);
            assert.equal(response.headers.get("cache-control"), "private, no-store");
        }
        const error = await load(path, { [name]: async () => { throw new Error("private-error"); } })(request(), context);
        assert.equal(error.status, 503);
        assert.equal(error.headers.get("cache-control"), "private, no-store");
        assert(!(await error.text()).includes("private-error"));
    }
});
