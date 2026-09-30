import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://council-owner.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";
const { listOwnerAttempts, readOwnerAttempt, readOwnerVerification } = await import("../src/lib/council/owner-evidence-reader.ts");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = "a".repeat(40), tip = "b".repeat(40), digest = "c".repeat(64);
const manifest = { version: 1, campaignId: id(100), baseSha: base, items: [{ itemId: id(101), sequence: 1, agentName: "seat", branch: "council/item", commitSha: tip, verificationRunId: id(102), dependencies: [], acceptedExecutionId: id(103), executionEvidence: null }] };
const attempt = (n: number, session = id(1)) => ({
    id: id(n), session_id: session, campaign_id: id(100), attempt_number: n, status: "verified", mode: "host", integrator_agent: null,
    manifest_hash: digest, base_branch: "main", base_sha: base, branch: "council/integration", tip_sha: tip,
    started_at: "2026-09-30T00:00:00Z", finished_at: "2026-09-30T00:01:00Z", manifest, decision: null, open_questions: [],
    execution_id: null, execution_evidence: null, evidence: null, host_id: "private-host", lease_epoch: 123, result_digest: "private-result",
});
const verification = () => ({
    id: id(102), work_item_id: id(101), commit_sha: tip, base_sha: base, execution_id: id(103), profile_id: "standard", passed: true,
    checked_at: "2026-09-30T00:00:00Z", command_receipts: [{ command: ["private-argv"], exitCode: 0, durationMs: 23, outputDigest: digest, outputTail: "private-output", timedOut: false }],
    item: { campaign_id: id(100), campaign: { session_id: id(1) } }, host_id: "private-host", lease_epoch: 99,
});
let attempts = Array.from({ length: 25 }, (_, i) => attempt(30 - i));
let run = verification();
let unavailable = false;
const requests: URL[] = [];
mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://council-owner.invalid");
    assert.equal(init?.method ?? "GET", "GET");
    requests.push(url);
    if (unavailable) return new Response(JSON.stringify({ message: "synthetic failure" }), { status: 503 });
    let found: Record<string, unknown>[];
    if (url.pathname.endsWith("council_integration_attempts")) {
        found = attempts.filter(row => `eq.${row.session_id}` === url.searchParams.get("session_id"));
        if (url.searchParams.has("id")) found = found.filter(row => `eq.${row.id}` === url.searchParams.get("id"));
        if (url.searchParams.has("attempt_number")) found = found.filter(row => Number(row.attempt_number) < Number(url.searchParams.get("attempt_number")!.slice(3)));
    } else { assert(url.pathname.endsWith("council_verification_runs")); found = [run]; }
    found = found.slice(0, Number(url.searchParams.get("limit") ?? found.length));
    const data = String(new Headers(init?.headers).get("accept")).includes("object") ? found[0] ?? null : found;
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
});
after(() => mock.restoreAll());
beforeEach(() => { requests.length = 0; unavailable = false; attempts = Array.from({ length: 25 }, (_, i) => attempt(30 - i)); run = verification(); });

test("attempt history is bounded and retains prior attempts without private metadata", async () => {
    const page = await listOwnerAttempts(id(1));
    assert.equal(page.attempts.length, 20);
    assert.equal(page.nextCursor, 11);
    assert(!JSON.stringify(page).includes("private"));
    assert(!requests[0].searchParams.get("select")!.includes("evidence"));
    const older = await listOwnerAttempts(id(1), page.nextCursor);
    assert.deepEqual(older.attempts.map(row => row.attemptNumber), [10, 9, 8, 7, 6]);
});

test("missing attempts and unavailable reads have different states", async () => {
    assert.equal((await readOwnerAttempt(id(2), id(30))).status, "not_found");
    unavailable = true;
    assert.equal((await readOwnerAttempt(id(1), id(30))).status, "unavailable");
    assert.equal((await listOwnerAttempts(id(1))).status, "unavailable");
});

test("legacy receipt argv and output are withheld while exact run metadata stays useful", async () => {
    const result = await readOwnerVerification(id(1), id(30), id(102));
    assert.equal(result.status, "available");
    assert.equal(result.verification?.receipts[0].durationMs, 23);
    assert.equal(result.verification?.receipts[0].textStatus, "withheld");
    assert(!JSON.stringify(result).includes("private"));
});

test("verification reads reject cross-Council, wrong-run, item, SHA, base and execution substitutions", async () => {
    assert.equal((await readOwnerVerification(id(1), id(30), id(777))).status, "not_found");
    assert.equal(requests.filter(url => url.pathname.endsWith("council_verification_runs")).length, 0);
    for (const mutate of [
        () => { run.item.campaign.session_id = id(2); },
        () => { run.work_item_id = id(999); },
        () => { run.commit_sha = "d".repeat(40); },
        () => { run.base_sha = "d".repeat(40); },
        () => { run.execution_id = id(999); },
    ]) {
        run = verification(); mutate();
        assert.equal((await readOwnerVerification(id(1), id(30), id(102))).status, "unavailable");
    }
});

test("only validated versioned evidence exposes sanitised bounded text and no private columns", async () => {
    const evidence = { version: 1, redactionVersion: 1, receipts: [{ command: ["npm", "test", "--token=do-not-expose"], exitCode: 0, durationMs: 12, outputDigest: digest, outputTail: "Bearer do-not-expose\nC:\\Users\\someone\\private.txt", timedOut: false }], changedPaths: ["src/app.ts"], diffSummary: "one file changed", protectedRefs: { before: { main: base }, after: { main: base } }, conflictNotes: null, manualChecks: [] };
    Object.assign(attempts[0], { evidence, decision: "token=do-not-expose", open_questions: ["Review C:\\Users\\someone\\private.txt"] });
    const result = await readOwnerAttempt(id(1), id(30));
    assert.equal(result.status, "available");
    assert.equal(result.attempt?.evidenceStatus, "available");
    const json = JSON.stringify(result);
    assert(!json.includes("do-not-expose"));
    assert(!json.includes("someone"));
    assert(!json.includes("private-host"));
    assert(!json.includes("private-result"));
    for (const url of requests) assert(!/host_id|lease_epoch|result_digest|seat_token_hash/.test(url.searchParams.get("select")!));
    Object.assign(attempts[0], { evidence: { ...evidence, version: 2 } });
    assert.equal((await readOwnerAttempt(id(1), id(30))).attempt?.evidenceStatus, "unavailable");
    Object.assign(attempts[0], { evidence: null });
    assert.equal((await readOwnerAttempt(id(1), id(30))).attempt?.evidenceStatus, "not_recorded");
});

test("versioned exact item receipts are redacted again before display", async () => {
    Object.assign(run.command_receipts[0], { redactionVersion: 1, command: ["npm", "test", "--token=synthetic-sensitive"], outputTail: "token=synthetic-sensitive" });
    const result = await readOwnerVerification(id(1), id(30), id(102));
    assert.equal(result.status, "available");
    assert.equal(result.verification?.receipts[0].textStatus, "redacted");
    assert(!JSON.stringify(result).includes("synthetic-sensitive"));
    Object.assign(run.command_receipts[0], { redactionVersion: 2 });
    assert.equal((await readOwnerVerification(id(1), id(30), id(102))).verification?.receipts[0].textStatus, "withheld");
});
