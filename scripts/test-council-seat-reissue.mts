import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Session = { id: string; status: string; pausedAt: string | null };
type Campaign = { status: string; integrationStatus: string | null };
type IssueArgs = { sessionId: string; seatName: string; ttlHours?: number };
type IssueResult = { ok: true; token: string; expiresAt: string } | { ok: false; reason: string };
type Context = { params: Promise<{ code: string }> };
const sessionId = "10000000-0000-4000-8000-000000000001";
const issuedAt = Date.parse("2026-09-30T00:00:00Z");
let session: Session | null;
let campaign: Campaign | null;
let lookupFailure: "session" | "campaign" | "issue" | undefined;
let rejection: string | undefined;
const io: string[] = [];
const issued: IssueArgs[] = [];
const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json } },
    "@/lib/council/store": {
        getSessionByCode: async () => {
            io.push("session");
            if (lookupFailure === "session") throw new Error("Offline session lookup failed");
            return session;
        },
    },
    "@/lib/council/campaign": {
        getCampaignForSession: async (id: string) => {
            assert.equal(id, sessionId);
            io.push("campaign");
            if (lookupFailure === "campaign") throw new Error("Offline campaign lookup failed");
            return campaign;
        },
    },
    "@/lib/council/seat-keys": {
        issueSeatKey: async (args: IssueArgs): Promise<IssueResult> => {
            io.push("issue");
            issued.push(structuredClone(args));
            if (lookupFailure === "issue") throw new Error("Offline issuance failed");
            if (rejection) return { ok: false, reason: rejection };
            return {
                ok: true, token: "offline-seat-fixture",
                expiresAt: new Date(issuedAt + (args.ttlHours ?? 24) * 3_600_000).toISOString(),
            };
        },
    },
};
const path = "../src/app/api/council/[code]/seat-key/route.ts";
const source = readFileSync(new URL(path, import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports: Record<string, unknown> = {};
runInNewContext(compiled, {
    exports, console: { error: () => undefined },
    require: (id: string) => {
        assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
        return dependencies[id];
    },
}, { filename: path });
const post = exports.POST as (req: Request, context: Context) => Promise<Response>;
let passed = 0;
let failed = 0;
async function check(name: string, run: () => Promise<void>) {
    session = { id: sessionId, status: "open", pausedAt: null };
    campaign = null;
    lookupFailure = undefined;
    rejection = undefined;
    io.length = 0;
    issued.length = 0;
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
const invoke = (body: unknown = { seatName: "  guest-a  " }) => post(new Request("https://offline.invalid", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ code: "CN-TEST" }) });
async function expectAllowed() {
    const response = await invoke();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        seatName: "guest-a", token: "offline-seat-fixture", expiresAt: "2026-10-01T00:00:00.000Z",
    });
    assert.equal(issued.length, 1);
    assert.equal(issued[0].sessionId, sessionId);
    assert.equal(issued[0].seatName, "guest-a");
    assert.equal(issued[0].ttlHours ?? 24, 24);
}
async function expectDenied(status: number, calls: string[]) {
    const response = await invoke();
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.equal(body.token, undefined);
    assert.equal(body.expiresAt, undefined);
    assert.deepEqual(io, calls);
    assert.equal(issued.length, 0);
}

for (const status of ["open", "concluding"]) await check(`${status} Council mints a bounded 24-hour guest key`, async () => {
    session!.status = status;
    await expectAllowed();
});
await check("an existing campaign never extends a guest key beyond 24 hours", async () => {
    campaign = { status: "running", integrationStatus: null };
    await expectAllowed();
});
for (const [status, integrationStatus] of [
    ["running", null], ["blocked", null], ["complete", null], ["complete", "pending"], ["complete", "running"],
] as const) await check(`closed Council permits reissue for ${status}/${integrationStatus ?? "unset"}`, async () => {
    session!.status = "closed";
    campaign = { status, integrationStatus };
    await expectAllowed();
    assert.deepEqual(io, ["session", "campaign", "issue"]);
});
for (const [status, integrationStatus] of [
    ["cancelled", null], ["cancelled", "running"], ["complete", "verified"], ["complete", "conflict"],
    ["complete", "failed"], ["complete", "unknown"], ["unknown", null],
] as const) await check(`closed Council denies terminal or unknown ${status}/${integrationStatus ?? "unset"}`, async () => {
    session!.status = "closed";
    campaign = { status, integrationStatus };
    await expectDenied(409, ["session", "campaign"]);
});
await check("closed Council without a campaign cannot mint", async () => {
    session!.status = "closed";
    await expectDenied(409, ["session", "campaign"]);
});
for (const status of ["expired", "awaiting_owner", "unknown"]) await check(`${status} Council cannot mint even with unfinished work`, async () => {
    session!.status = status;
    campaign = { status: "running", integrationStatus: null };
    await expectDenied(409, ["session"]);
});
for (const status of ["open", "concluding", "closed"]) await check(`paused ${status} Council cannot mint`, async () => {
    session!.status = status;
    session!.pausedAt = "2026-09-30T00:00:00Z";
    campaign = { status: "running", integrationStatus: null };
    await expectDenied(409, ["session"]);
});
await check("missing Council returns 404 without issuance", async () => {
    session = null;
    await expectDenied(404, ["session"]);
});
for (const failure of ["session", "campaign"] as const) await check(`${failure} lookup failure fails closed`, async () => {
    session!.status = "closed";
    lookupFailure = failure;
    await expectDenied(500, failure === "session" ? ["session"] : ["session", "campaign"]);
});
for (const reason of ["inactive_session", "not_on_roster", "not_an_agent_seat"]) await check(`atomic issuer rejection ${reason} returns no credential`, async () => {
    rejection = reason;
    const response = await invoke();
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.equal(body.token, undefined);
    assert.equal(body.expiresAt, undefined);
    if (reason === "inactive_session") assert.match(body.error, /no longer|not active|inactive/i);
    assert.equal(issued.length, 1);
});
await check("issuer transport failure returns no credential", async () => {
    lookupFailure = "issue";
    const response = await invoke();
    assert.equal(response.status, 500);
    assert.equal((await response.json()).token, undefined);
});
await check("missing guest name is rejected before lookup", async () => {
    const response = await invoke({ seatName: "  " });
    assert.equal(response.status, 400);
    assert.deepEqual(io, []);
});

console.log(`Council guest reissue route tests: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
