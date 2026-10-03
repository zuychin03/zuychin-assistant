import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://council-evidence.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";
const { readExecutionEvidence, parseExecutionCursor } = await import("../src/lib/council/execution-reader.ts");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, session = "session") => ({
    id: id(n), session_id: session, connector_kind: "acp", identity_assurance: "host_verified", provider: "fixture",
    adapter_version: "1", requested_model: "requested", effective_model: `model-${n}`, requested_reasoning_effort: null,
    effective_reasoning_effort: null, model_source: "adapter_config", started_at: "2026-09-30T00:00:00.000000+00:00",
    ended_at: null, predecessor_execution_id: null, participant: { name: "reviewer", session_id: session },
    token_hash: "must-not-leak", host_id: "must-not-leak", worktree_path: "must-not-leak",
    host_generation: n === 1 ? null : "typescript-node", policy_version: n === 1 ? null : "typescript-node-v3-2026-09-30",
});
let rows = Array.from({ length: 60 }, (_, i) => row(60 - i));
let failHistory = false, failReferences = false;
const requests: URL[] = [];
mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://council-evidence.invalid");
    assert.equal(url.pathname, "/rest/v1/council_agent_executions");
    assert.equal(init?.method ?? "GET", "GET", "Evidence reads must never mutate");
    requests.push(url);
    const references = url.searchParams.has("id");
    if (references ? failReferences : failHistory) return new Response(JSON.stringify({ message: "synthetic unavailable" }), { status: 503 });
    let found = rows.filter(row => `eq.${row.session_id}` === url.searchParams.get("session_id"));
    const ids = url.searchParams.get("id");
    if (ids) found = found.filter(row => ids.includes(row.id));
    const cursor = url.searchParams.get("or");
    if (cursor) found = found.filter(row => row.id < cursor.match(/id\.lt\.([^)]*)/)![1]);
    const limit = Number(url.searchParams.get("limit") ?? found.length);
    return new Response(JSON.stringify(found.slice(0, limit)), { headers: { "Content-Type": "application/json" } });
});
after(() => mock.restoreAll());
beforeEach(() => { failHistory = false; failReferences = false; requests.length = 0; rows = Array.from({ length: 60 }, (_, i) => row(60 - i)); });

test("bounded keyset history and old referenced records are read separately with a session fence", async () => {
    rows.push(row(99, "other-session"));
    const page = await readExecutionEvidence("session", { referencedIds: [id(1), id(60), id(99), null] });
    assert.equal(page.records.length, 50);
    assert.equal(page.records[0].executionId, id(60));
    assert.equal(page.records[0].hostGeneration, "typescript-node");
    assert.equal(page.records[0].policyVersion, "typescript-node-v3-2026-09-30");
    assert.equal(page.referencedRecords[0].hostGeneration, null);
    assert.equal(page.referencedRecords[0].policyVersion, null);
    assert.deepEqual(page.referencedRecords.map(row => row.executionId), [id(1)]);
    assert.equal(page.referencesStatus, "unavailable");
    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(request.searchParams.get("session_id"), "eq.session");
        assert(!request.searchParams.get("select")!.includes("host_id"));
        assert(!request.searchParams.get("select")!.includes("worktree"));
    }
    assert(!JSON.stringify(page).includes("must-not-leak"));
    const older = await readExecutionEvidence("session", { cursor: page.nextCursor });
    assert.deepEqual(older.records.map(row => row.executionId), Array.from({ length: 10 }, (_, i) => id(10 - i)));
    assert.equal(older.nextCursor, null);
});

test("history failure preserves exact referenced evidence and does not report empty history as known", async () => {
    failHistory = true;
    const page = await readExecutionEvidence("session", { referencedIds: [id(1)] });
    assert.equal(page.historyStatus, "unavailable");
    assert.equal(page.referencesStatus, "available");
    assert.equal(page.referencedRecords[0].executionId, id(1));
});

test("reference failure leaves the transcript's latest history available without substituting a run", async () => {
    failReferences = true;
    const page = await readExecutionEvidence("session", { referencedIds: [id(1)] });
    assert.equal(page.historyStatus, "available");
    assert.equal(page.referencesStatus, "unavailable");
    assert.deepEqual(page.referencedRecords, []);
});

test("a cross-session participant join cannot expose another Council's evidence", async () => {
    rows[0].participant.session_id = "other-session";
    const page = await readExecutionEvidence("session");
    assert.equal(page.historyStatus, "unavailable");
    assert(!page.records.some(row => row.executionId === id(60)));
});

test("cursor injection is rejected before any database request", async () => {
    for (const cursor of ["not-json", JSON.stringify({ id: "x),id.gt.0", startedAt: "2026-09-30T00:00:00Z" }), JSON.stringify({ id: id(1), startedAt: "2026-09-30),id.gt.0" })]) {
        assert.throws(() => parseExecutionCursor(cursor), /Invalid execution cursor/);
        await assert.rejects(readExecutionEvidence("session", { cursor }), /Invalid execution cursor/);
    }
    assert.equal(requests.length, 0);
});
