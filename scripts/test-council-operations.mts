import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import * as scopes from "../src/lib/agents/scopes.ts";
import * as readAccess from "../src/lib/agents/read-access.ts";
import * as hostContracts from "../src/lib/council/host-contracts.ts";
import * as protocol from "../src/lib/council/protocol.ts";
import * as render from "../src/lib/council/render.ts";
import * as templates from "../src/lib/council/templates.ts";
import * as v3 from "../src/lib/council/v3.ts";
import * as writeIdentity from "../src/lib/council/write-identity.ts";
import type { CouncilCampaign, CouncilWorkItem } from "../src/lib/council/campaign.ts";
import type { CouncilMessage, CouncilParticipant, CouncilSession } from "../src/lib/council/store.ts";

// Council operations are exercised directly, over recording fakes; the MCP
// route is never loaded, so every rule here holds for any transport.

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const HOST_ID = "44444444-4444-4444-8444-444444444444";
const EXECUTION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-10-07T00:00:00.000Z";
const SEAT_TOKEN = `zcs_${"b".repeat(64)}`;
const PARTICIPANT_REQUIRED = "This tool needs an owner API key or a council seat key; the key you used has neither.";
const HOST_REQUIRED = "This tool requires the dedicated Council host credential.";

const baseSession: CouncilSession = {
    id: SESSION_ID, code: "CN-TEST", topic: "Fixture Council", brief: "Offline only", closerName: "closer", councilType: "code",
    status: "open", round: 2, maxRounds: 4, maxMessages: 48, lastSeq: 9, lastMessageAt: NOW,
    quorumAt: NOW, floorHolder: null, floorGrantedAt: null, floorEpoch: 0, silentGrants: 0,
    verdict: null, openQuestions: [], archiveStatus: "pending", vaultPath: null,
    expiresAt: NOW, closedAt: null, createdAt: NOW, repoPath: "/fixture", baseBranch: "main",
    protocolVersion: 3, baseSha: "a".repeat(40), pausedAt: null, pausedTotalSeconds: 0,
    verdictProposedAt: null, standbyExpiresAt: null, continueCount: 0,
};
const baseCampaign: CouncilCampaign = {
    id: "campaign-fixture", sessionId: SESSION_ID, status: "running", repoPath: "/fixture", baseBranch: "main", createdAt: NOW,
    completedAt: null, integratorAgent: null, integrationBranch: null, integrationStatus: null, integrationReport: null,
    integrationCheckedAt: null, baseSha: "a".repeat(40), verificationProfile: "standard", integrationManifest: null,
    manifestFrozenAt: null, integrationTipSha: null,
};
const message: CouncilMessage = {
    seq: 9, round: 2, speaker: "agent-c", role: "agent", addressedTo: "all", intent: "propose",
    replyToSeq: null, body: "Fixture proposal", answered: false, createdAt: NOW, executionId: null,
};

function participant(name: string, overrides: Partial<CouncilParticipant> = {}): CouncilParticipant {
    return {
        name, kind: "agent", expertise: "fixture", status: "active", postsTotal: 0, postsThisRound: 0, cursorSeq: 4,
        pendingAckSeq: 0, expiredGrants: 0, waitCalls: 0, joinedSeq: 1, lastSeenAt: NOW, dispatchMode: false, ...overrides,
    };
}

function workItem(id: string, agentName: string, status: CouncilWorkItem["status"], overrides: Partial<CouncilWorkItem> = {}): CouncilWorkItem {
    return {
        id, campaignId: baseCampaign.id, sequence: 1, agentName, title: `task ${id}`,
        instructions: "Offline only", acceptanceCriteria: ["passes"], status, heartbeatAt: NOW, attempts: 1,
        progress: null, commitHash: null, verification: null, hostVerified: null, hostVerification: null, hostCheckedAt: null,
        declaredPaths: ["src/a.ts"], blockedReason: null, startedAt: NOW, completedAt: null, reviewedAt: null,
        branchName: `council/cn-test/${agentName}`, acceptedCommitSha: null, verificationProfile: "standard",
        verificationRunId: null, dependencies: [], submittedExecutionId: null, acceptedExecutionId: null, ...overrides,
    };
}

interface World {
    session: CouncilSession | null;
    participants: CouncilParticipant[];
    joined: { ok: boolean };
    appended: Record<string, unknown>;
    open: CouncilSession[];
    campaign: CouncilCampaign | null;
    items: CouncilWorkItem[];
    claimed: CouncilWorkItem | null;
    review: { ok: boolean; reason?: string };
    dispatched: unknown;
    acks: { ok: boolean; reason?: string }[];
    prepared: (args: Record<string, unknown>) => unknown;
}

function freshWorld(): World {
    return {
        session: { ...baseSession }, participants: [participant("agent-a")], joined: { ok: true },
        appended: { ok: true, seq: 10, round: 2 }, open: [], campaign: baseCampaign, items: [], claimed: null,
        review: { ok: true }, dispatched: { kind: "degraded" }, acks: [],
        prepared: () => ({ ok: false, reason: "unexpected" }),
    };
}

let world = freshWorld();
const calls: { name: string; args: unknown[] }[] = [];
const called = () => calls.map((call) => call.name);
const env: Record<string, string | undefined> = {};

function boundary(name: string, answer: (...args: unknown[]) => unknown) {
    return async (...args: unknown[]) => {
        calls.push({ name, args });
        return answer(...args);
    };
}

const dependencies: Record<string, unknown> = {
    "@/lib/agents/scopes": scopes, "@/lib/agents/read-access": readAccess,
    "@/lib/council/host-contracts": hostContracts, "@/lib/council/protocol": protocol,
    "@/lib/council/render": render, "@/lib/council/templates": templates,
    "@/lib/council/v3": v3, "@/lib/council/write-identity": writeIdentity,
    "@/lib/council/store": {
        getSessionByCode: boundary("getSessionByCode", () => world.session),
        listParticipants: boundary("listParticipants", () => world.participants),
        getParticipant: boundary("getParticipant", (_id, name) => world.participants.find((p) => p.name === name) ?? null),
        joinCouncil: boundary("joinCouncil", () => world.joined),
        readTranscript: boundary("readTranscript", () => []),
        appendMessage: boundary("appendMessage", () => world.appended),
        leaveCouncil: boundary("leaveCouncil", () => undefined),
        listOpenCouncils: boundary("listOpenCouncils", () => world.open),
        createCouncilSession: boundary("createCouncilSession", () => world.session),
    },
    "@/lib/council/campaign": {
        getCampaignForSession: boundary("getCampaignForSession", () => world.campaign),
        listCampaignWorkItems: boundary("listCampaignWorkItems", () => world.items),
        claimNextWorkItem: boundary("claimNextWorkItem", () => world.claimed),
        heartbeatWorkItem: boundary("heartbeatWorkItem", () => true),
        completeWorkItem: boundary("completeWorkItem", () => true),
        blockWorkItem: boundary("blockWorkItem", () => true),
        reviewWorkItem: boundary("reviewWorkItem", () => world.review),
    },
    "@/lib/council/close": {
        proposeCouncilVerdict: boundary("proposeCouncilVerdict", () => ({ changed: true, verdict: "v", closer: "closer", status: "awaiting_owner" })),
    },
    "@/lib/council/wait": {
        pollCouncil: boundary("pollCouncil", () => ({ kind: "waiting" })),
        dispatchCouncil: boundary("dispatchCouncil", () => world.dispatched),
    },
    "@/lib/council/service": {
        councilHostService: {
            acknowledgeDelivery: boundary("acknowledgeDelivery", () => world.acks.shift() ?? { ok: true }),
            prepareDelivery: boundary("prepareDelivery", (args) => world.prepared(args as Record<string, unknown>)),
        },
    },
};

// Evaluated in this realm so results compare structurally with local fixtures.
const ops = (() => {
    const exports = {};
    const source = readFileSync(new URL("../src/lib/council/operations.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const evaluate = runInThisContext(`(function (exports, require, process) {${compiled}
})`, { filename: "operations.ts" });
    evaluate(exports, (id: string) => {
        assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
        return dependencies[id];
    }, { env });
    return exports as typeof import("../src/lib/council/operations.ts");
})();

type Caller = Parameters<typeof ops.joinAsSeat>[1];
type Auth = NonNullable<Caller>;
const seat = (name = "agent-a", sessionId = SESSION_ID, extra?: Record<string, unknown>): Auth => ({
    token: SEAT_TOKEN, clientId: `council-seat:${sessionId}:${name}`, scopes: ["council:seat"], ...(extra ? { extra } : {}),
});
const owner: Auth = { token: "owner-fixture", clientId: "agent:owner", scopes: [...scopes.OWNER_SCOPES] };
const host: Auth = { token: "host-fixture", clientId: "council-host", scopes: ["council:host"] };
const reader: Auth = { token: "reader-fixture", clientId: "agent:reader", scopes: ["knowledge:read"] };
const seatWriteIdentity = { tokenHash: createHash("sha256").update(SEAT_TOKEN).digest("hex"), executionId: null };

beforeEach(() => {
    calls.length = 0;
    delete env.COUNCIL_V2_ASSERTED_IDENTITY;
    world = freshWorld();
});

const sessionOps: [string, (caller: Caller) => Promise<{ kind: string }>][] = [
    ["joinAsSeat", (caller) => ops.joinAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a" }, caller)],
    ["waitAsSeat", (caller) => ops.waitAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a", waitMs: 1_000 }, caller)],
    ["speakAsSeat", (caller) => ops.speakAsSeat({
        sessionCode: "CN-TEST", agentName: "agent-a", intent: "propose", message: "Fixture", clientKey: "k-1", waitMs: 1_000,
    }, caller)],
    ["concludeAsSeat", (caller) => ops.concludeAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a", verdict: "Fixture" }, caller)],
    ["passAsSeat", (caller) => ops.passAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a", reason: "Nothing to add" }, caller)],
    ["claimWorkAsSeat", (caller) => ops.claimWorkAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a" }, caller)],
];
const workOps: [string, (caller: Caller) => Promise<{ kind: string }>][] = [
    ["heartbeatWorkAsSeat", (caller) => ops.heartbeatWorkAsSeat({ itemId: ITEM_ID, agentName: "agent-a" }, caller)],
    ["completeWorkAsSeat", (caller) => ops.completeWorkAsSeat({
        itemId: ITEM_ID, agentName: "agent-a", commitHash: "c".repeat(40), verification: "Checks passed.",
    }, caller)],
    ["blockWorkAsSeat", (caller) => ops.blockWorkAsSeat({ itemId: ITEM_ID, agentName: "agent-a", reason: "Needs a decision." }, caller)],
    ["reviewWorkAsSeat", (caller) => ops.reviewWorkAsSeat({ itemId: ITEM_ID, agentName: "agent-a", accepted: true, note: "Reviewed." }, caller)],
];

test("a seat key binds its holder to one Council and one seat name", () => {
    const scope = { sessionId: SESSION_ID, agentName: "agent-a", protocolVersion: 3 };
    const refusals: [Caller, Parameters<typeof ops.seatDenial>[1], string][] = [
        [owner, scope, "Council V3 requires the participant's seat credential."],
        [owner, { agentName: "agent-a" }, "Agent work requires a Council seat credential."],
        [{ ...seat(), clientId: "agent:client-fixture" }, scope, "This tool needs a read-write API key."],
        [{ ...seat(), clientId: `council-seat:${SESSION_ID}` }, scope, "This tool needs a read-write API key."],
        [seat("agent-a", SESSION_ID, { councilExecutionBindingRequired: true }), scope, "This seat is waiting for its execution binding."],
        [seat("agent-a", OTHER_SESSION_ID), scope, "That seat key belongs to a different council."],
        [seat("agent-b"), scope, 'That seat key is for the seat "agent-b", not "agent-a".'],
    ];
    for (const [caller, seatScope, expected] of refusals) assert.equal(ops.seatDenial(caller, seatScope), expected);
    assert.equal(ops.seatDenial(seat("agent:a"), { ...scope, agentName: "agent:a" }), null);
    assert.equal(ops.seatDenial(seat("agent-a", SESSION_ID, { councilExecutionBindingRequired: true, councilExecutionId: EXECUTION_ID }), scope), null);
    assert.equal(ops.seatDenial(owner, { ...scope, protocolVersion: 2 }), null);
    env.COUNCIL_V2_ASSERTED_IDENTITY = "true";
    assert.equal(ops.seatDenial(owner, { agentName: "agent-a" }), null);
});

for (const [name, run] of [...sessionOps, ...workOps]) {
    test(`${name} refuses a key that cannot act as a seat before any read or write`, async () => {
        for (const caller of [undefined, reader, host]) {
            calls.length = 0;
            assert.deepEqual(await run(caller), { kind: "denied", message: PARTICIPANT_REQUIRED });
            assert.deepEqual(called(), []);
        }
    });
}

for (const [name, run] of sessionOps) {
    test(`${name} refuses anyone but the bound seat after only the session lookup`, async () => {
        const refusals: [Caller, string][] = [
            [seat("agent-a", OTHER_SESSION_ID), "That seat key belongs to a different council."],
            [seat("agent-b"), 'That seat key is for the seat "agent-b", not "agent-a".'],
            [seat("agent-a", SESSION_ID, { councilExecutionBindingRequired: true }), "This seat is waiting for its execution binding."],
            [owner, "Council V3 requires the participant's seat credential."],
        ];
        for (const [caller, expected] of refusals) {
            calls.length = 0;
            assert.deepEqual(await run(caller), { kind: "denied", message: expected });
            assert.deepEqual(called(), ["getSessionByCode"]);
        }
    });
}

for (const [name, run] of workOps) {
    test(`${name} refuses another seat's name and an owner key without touching the item`, async () => {
        const refusals: [Caller, string][] = [
            [seat("agent-b"), 'That seat key is for the seat "agent-b", not "agent-a".'],
            [seat("agent-a", SESSION_ID, { councilExecutionBindingRequired: true }), "This seat is waiting for its execution binding."],
            [owner, "Agent work requires a Council seat credential."],
        ];
        for (const [caller, expected] of refusals) {
            calls.length = 0;
            assert.deepEqual(await run(caller), { kind: "denied", message: expected });
            assert.deepEqual(called(), []);
        }
    });
}

test("an unknown Council code ends every session operation after the lookup", async () => {
    world.session = null;
    for (const [name, run] of sessionOps) {
        calls.length = 0;
        assert.deepEqual(await run(seat()), { kind: "unknown_session" }, name);
        assert.deepEqual(called(), ["getSessionByCode"], name);
    }
});

test("joining returns the roster and recent transcript, or only the roster for a refused name", async () => {
    assert.equal((await ops.joinAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a", dispatchMode: true }, seat())).kind, "joined");
    assert.deepEqual(called(), ["getSessionByCode", "joinCouncil", "listParticipants", "readTranscript"]);
    assert.deepEqual(calls[1].args, [{ sessionId: SESSION_ID, agentName: "agent-a", expertise: undefined, dispatchMode: true }]);
    assert.deepEqual(calls[3].args, [{ sessionId: SESSION_ID, limit: 20 }]);
    world.joined = { ok: false };
    calls.length = 0;
    assert.equal((await ops.joinAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a" }, seat())).kind, "rejected");
    assert.deepEqual(called(), ["getSessionByCode", "joinCouncil", "listParticipants"]);
});

test("only the designated closer can propose a verdict", async () => {
    const workItems = [{ agentName: "agent-a", title: "Do it", instructions: "Exactly", acceptanceCriteria: ["passes"] }];
    const refused = await ops.concludeAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a", verdict: "Ship it.", workItems }, seat());
    assert.equal(refused.kind, "not_closer");
    assert.deepEqual(called(), ["getSessionByCode"]);
    calls.length = 0;
    const proposed = await ops.concludeAsSeat({ sessionCode: "CN-TEST", agentName: "closer", verdict: "Ship it.", workItems }, seat("closer"));
    assert.equal(proposed.kind, "proposed");
    assert.deepEqual(called(), ["getSessionByCode", "proposeCouncilVerdict"]);
    const [proposal] = calls[1].args as [{ closer: string; verdict: string; openQuestions: string[]; workItems: unknown[] }];
    assert.equal(proposal.closer, "closer");
    assert.deepEqual(proposal.openQuestions, []);
    assert.deepEqual(proposal.workItems, workItems);
    assert.notEqual(proposal.workItems[0], workItems[0]);
});

test("a host-dispatched seat is never long-polled", async () => {
    world.participants = [participant("agent-a", { dispatchMode: true, cursorSeq: 7 })];
    const held = await ops.waitAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a", waitMs: 30_000 }, seat());
    assert.equal(held.kind === "dispatched" && held.cursor, 7);
    const claimed = await ops.waitAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a", sinceSeq: 3, waitMs: 30_000 }, seat());
    assert.equal(claimed.kind === "dispatched" && claimed.cursor, 3);
    assert(!called().includes("pollCouncil"));
    world.participants = [participant("agent-a")];
    calls.length = 0;
    assert.equal((await ops.waitAsSeat({ sessionCode: "CN-TEST", agentName: "agent-a", sinceSeq: 3, waitMs: 30_000 }, seat())).kind, "polled");
    assert.deepEqual(called(), ["getSessionByCode", "getParticipant", "pollCouncil"]);
    assert.deepEqual(calls[2].args, [{ session: baseSession, agentName: "agent-a", sinceSeq: 3, waitMs: 30_000, signal: undefined }]);
});

test("speech carries the seat's own identity, and a dispatched seat is not held after posting", async () => {
    world.participants = [participant("agent-a", { dispatchMode: true, cursorSeq: 5 })];
    world.appended = { ok: true, seq: 10, round: 3, advanced: true };
    const advanced: unknown[] = [];
    const body = "x".repeat(protocol.MAX_BODY_CHARS + 5);
    const result = await ops.speakAsSeat({
        sessionCode: "CN-TEST", agentName: "agent-a", intent: "propose", message: body, clientKey: "k-1", sinceSeq: 4,
        waitMs: 30_000, onRoundAdvanced: (...args) => advanced.push(args),
    }, seat());
    assert.equal(result.kind, "dispatched");
    if (result.kind !== "dispatched") return;
    assert.equal(result.cursor, 4);
    assert.equal(result.post.truncatedChars, 5);
    assert.equal(result.post.addressedTo, "all");
    assert.deepEqual(advanced, [[SESSION_ID, 3]]);
    assert.deepEqual(called(), ["getSessionByCode", "listParticipants", "appendMessage"]);
    assert.deepEqual(calls[2].args, [{
        sessionId: SESSION_ID, speaker: "agent-a", intent: "propose", body, clientKey: "k-1",
        addressedTo: "all", replyToSeq: undefined, ackSeq: 4, identity: seatWriteIdentity,
    }]);
});

test("only a listed agent may speak, and a polling seat's wait after posting spends no budget", async () => {
    world.participants = [participant("agent-a", { kind: "moderator" })];
    const speak = { sessionCode: "CN-TEST", agentName: "agent-a", intent: "propose", message: "Fixture", clientKey: "k-1", sinceSeq: 4, waitMs: 30_000 };
    assert.equal((await ops.speakAsSeat(speak, seat())).kind, "not_participant");
    assert(!called().includes("appendMessage"));
    world.participants = [participant("agent-a")];
    calls.length = 0;
    assert.equal((await ops.speakAsSeat(speak, seat())).kind, "posted");
    assert.deepEqual(calls.find((call) => call.name === "pollCouncil")?.args, [{
        session: baseSession, agentName: "agent-a", sinceSeq: 4, waitMs: 30_000, countWait: false, signal: undefined,
    }]);
});

test("a pass is keyed per seat, round and kind, and done leaves the Council", async () => {
    const pass = { sessionCode: "CN-TEST", agentName: "agent-a", reason: "Nothing new" };
    const clientKey = () => (calls.find((call) => call.name === "appendMessage")?.args[0] as { clientKey: string }).clientKey;
    world.appended = { ok: true, seq: 11, round: 2, advanced: true };
    assert.deepEqual(await ops.passAsSeat(pass, seat()), { kind: "passed", session: baseSession, cursor: 11, advanced: true });
    assert.equal(clientKey(), "agent-a-pass-r2-round");
    calls.length = 0;
    assert.equal((await ops.passAsSeat({ ...pass, done: true }, seat())).kind, "left");
    assert.equal(clientKey(), "agent-a-pass-r2-done");
    assert.deepEqual(calls.at(-1), { name: "leaveCouncil", args: [SESSION_ID, "agent-a"] });
    calls.length = 0;
    world.appended = { ok: false, reason: "quota", round: 2 };
    assert.deepEqual(await ops.passAsSeat({ ...pass, done: true }, seat()), { kind: "refused", session: baseSession, reason: "quota" });
    assert(!called().includes("leaveCouncil"));
});

test("work is claimable only once the Council is closed and its campaign exists", async () => {
    const claim = { sessionCode: "CN-TEST", agentName: "agent-a" };
    assert.deepEqual(await ops.claimWorkAsSeat(claim, seat()), { kind: "not_ready" });
    assert.deepEqual(called(), ["getSessionByCode"]);
    world.session = { ...baseSession, status: "closed" };
    world.campaign = null;
    calls.length = 0;
    assert.deepEqual(await ops.claimWorkAsSeat(claim, seat()), { kind: "no_campaign" });
    assert.deepEqual(called(), ["getSessionByCode", "getCampaignForSession"]);
    world.campaign = baseCampaign;
    assert.deepEqual(await ops.claimWorkAsSeat(claim, seat()), { kind: "idle", campaign: baseCampaign });
    world.claimed = workItem("item-1", "agent-a", "in_progress");
    assert.deepEqual(await ops.claimWorkAsSeat(claim, seat()), { kind: "assigned", item: world.claimed });
    assert.deepEqual(calls.at(-1), { name: "claimNextWorkItem", args: [SESSION_ID, "agent-a"] });
});

test("work updates forward only their own fields and the seat's identity", async () => {
    await ops.heartbeatWorkAsSeat({ itemId: ITEM_ID, agentName: "agent-a", progress: "half" }, seat());
    await ops.completeWorkAsSeat({ itemId: ITEM_ID, agentName: "agent-a", commitHash: "c".repeat(40), verification: "ok" }, seat());
    await ops.blockWorkAsSeat({ itemId: ITEM_ID, agentName: "agent-a", reason: "blocked" }, seat());
    world.review = { ok: false, reason: "not_the_closer" };
    const reviewed = await ops.reviewWorkAsSeat({ itemId: ITEM_ID, agentName: "agent-a", accepted: true, note: "fine" }, seat());
    assert.deepEqual(reviewed, { kind: "reviewed", result: { ok: false, reason: "not_the_closer" } });
    assert.deepEqual(calls, [
        { name: "heartbeatWorkItem", args: [{ itemId: ITEM_ID, agentName: "agent-a", progress: "half" }] },
        { name: "completeWorkItem", args: [{ itemId: ITEM_ID, agentName: "agent-a", commitHash: "c".repeat(40), verification: "ok", identity: seatWriteIdentity }] },
        { name: "blockWorkItem", args: [{ itemId: ITEM_ID, agentName: "agent-a", reason: "blocked" }] },
        { name: "reviewWorkItem", args: [{ itemId: ITEM_ID, reviewer: "agent-a", accepted: true, note: "fine" }] },
    ]);
});

const convene = {
    topic: "Fixture Council", brief: "Offline only", closerName: "agent-a",
    participants: [{ name: "agent-a", expertise: "x" }, { name: "agent-b", expertise: "y" }],
};

test("only an owner or host may convene, and only the host may choose the code", async () => {
    for (const caller of [undefined, reader, seat()]) {
        assert.deepEqual(await ops.conveneCouncil(convene, caller), { kind: "denied", message: "This tool requires an owner or Council host credential." });
    }
    await assert.rejects(ops.conveneCouncil({ ...convene, requestedCode: "CN-ABCD" }, owner), { message: HOST_REQUIRED });
    assert.deepEqual(called(), []);
});

test("convene rejects a malformed roster before reading or creating anything", async () => {
    const two = convene.participants;
    const cases: [{ name: string; expertise: string }[], string, unknown][] = [
        [[two[0]], "agent-a", { reason: "participant_count", count: 1 }],
        [Array.from({ length: 6 }, (_, i) => ({ name: `agent-${i}`, expertise: "x" })), "agent-0", { reason: "participant_count", count: 6 }],
        [two, "agent-c", { reason: "closer_not_participant", names: ["agent-a", "agent-b"] }],
        [[...two, { name: "agent-a", expertise: "z" }], "agent-a", { reason: "duplicate_names", names: ["agent-a", "agent-b", "agent-a"] }],
        [[...two, { name: protocol.MODERATOR_NAME, expertise: "z" }], "agent-a", { reason: "reserved_name", name: protocol.MODERATOR_NAME }],
        [[two[0], two[0]], "agent-c", { reason: "closer_not_participant", names: ["agent-a", "agent-a"] }],
    ];
    for (const [participants, closerName, rejection] of cases) {
        assert.deepEqual(await ops.conveneCouncil({ ...convene, participants, closerName }, owner), { kind: "rejected", rejection });
    }
    assert.deepEqual(called(), []);
});

test("convene stops at the open-Council cap and otherwise applies the template's budgets", async () => {
    world.open = [1, 2, 3].map((n) => ({ ...baseSession, code: `CN-000${n}` }));
    assert.deepEqual(await ops.conveneCouncil(convene, owner), { kind: "rejected", rejection: { reason: "open_limit", open: world.open } });
    assert.deepEqual(called(), ["listOpenCouncils"]);
    world.open = [];
    calls.length = 0;
    const result = await ops.conveneCouncil({
        ...convene, councilType: "code", maxRounds: 3, workspace: { repoPath: "/fixture" }, requestedCode: "CN-ABCD",
    }, host);
    assert.equal(result.kind, "convened");
    assert.deepEqual(called(), ["listOpenCouncils", "createCouncilSession", "listParticipants"]);
    assert.deepEqual(calls[1].args, [{
        topic: "Fixture Council", brief: "Offline only", closerName: "agent-a", participants: convene.participants,
        councilType: "code", requestedCode: "CN-ABCD", maxRounds: 3, maxMessages: 48, ttlMinutes: 120,
        workspace: { repoPath: "/fixture", baseBranch: "main", baseSha: undefined },
    }, host]);
});

const dispatch = { sessionCode: "CN-TEST", agentNames: ["agent-a", "agent-b", "agent-c"], hostId: HOST_ID, leaseEpoch: 2 };

test("dispatch is host-only, V3-only, and a status read cannot acknowledge", async () => {
    await assert.rejects(ops.prepareHostDispatch(dispatch, seat()), { message: HOST_REQUIRED });
    assert.deepEqual(await ops.prepareHostDispatch({ ...dispatch, statusOnly: true, ackDeliveryIds: [ITEM_ID] }, host), { error: "status_only_cannot_acknowledge" });
    assert.deepEqual(called(), []);
    world.session = { ...baseSession, protocolVersion: 2 };
    assert.deepEqual(await ops.prepareHostDispatch(dispatch, host), { error: "not_v3", sessionCode: "CN-TEST" });
    world.session = null;
    assert.deepEqual(await ops.prepareHostDispatch(dispatch, host), { error: "unknown_session", sessionCode: "CN-TEST" });
    assert(!called().includes("dispatchCouncil"));
});

test("a failed acknowledgement stops the tick before any turn is prepared", async () => {
    const second = "66666666-6666-4666-8666-666666666666";
    world.acks = [{ ok: true }, { ok: false, reason: "stale_host" }];
    assert.deepEqual(await ops.prepareHostDispatch({ ...dispatch, ackDeliveryIds: [ITEM_ID, second, EXECUTION_ID] }, host), {
        error: "stale_host", deliveryId: second,
    });
    assert.deepEqual(called(), ["getSessionByCode", "acknowledgeDelivery", "acknowledgeDelivery"]);
});

function dispatchView(agents: Record<string, { fresh: CouncilMessage[]; hasFloor: boolean; cursor: number }>) {
    return {
        kind: "ok", session: baseSession, floorHolder: "agent-b",
        view: {
            session: baseSession,
            participants: [
                participant("agent-a", { cursorSeq: 4 }), participant("agent-b", { cursorSeq: 9 }),
                participant("agent-c", { cursorSeq: 9 }), participant("agent-d", { status: "left" }),
            ],
            agents: Object.fromEntries(Object.entries(agents).map(([name, { fresh, hasFloor, cursor }]) => [name, {
                fresh, openToYou: [], cursor, delivered: fresh.length ? fresh[fresh.length - 1].seq : cursor,
                omittedBefore: null, hasFloor, moreRemain: false, status: "active", dispatchMode: true,
            }])),
        },
    };
}

test("only a seat with new messages or the floor gets a prepared turn", async () => {
    world.dispatched = dispatchView({
        "agent-a": { fresh: [message], hasFloor: false, cursor: 4 },
        "agent-b": { fresh: [], hasFloor: true, cursor: 9 },
        "agent-c": { fresh: [], hasFloor: false, cursor: 9 },
    });
    world.prepared = (args) => ({
        ok: true, delivery: { id: `delivery-${args.agentName}`, promptBody: args.promptBody, promptHash: args.promptHash, attempt: 1, redelivered: false },
    });
    const payload = await ops.prepareHostDispatch(dispatch, host) as { agents: Record<string, { prompt: string | null; deliveryId?: string }> };
    assert.equal(payload.agents["agent-c"].prompt, null);
    assert.equal(payload.agents["agent-a"].deliveryId, "delivery-agent-a");
    assert.equal(payload.agents["agent-b"].deliveryId, "delivery-agent-b");
    assert.deepEqual(calls.find((call) => call.name === "dispatchCouncil")?.args, [{ session: baseSession, agentNames: dispatch.agentNames, durable: true }]);
    const prepared = calls.filter((call) => call.name === "prepareDelivery").map((call) => call.args as [Record<string, unknown>, Caller]);
    assert.deepEqual(prepared.map(([args]) => [args.agentName, args.fromSeq, args.throughSeq]), [["agent-a", 4, 9], ["agent-b", 9, 9]]);
    for (const [args, caller] of prepared) {
        assert.equal(args.promptHash, createHash("sha256").update(String(args.promptBody)).digest("hex"));
        assert.deepEqual([args.sessionId, args.hostId, args.leaseEpoch, caller], [SESSION_ID, HOST_ID, 2, host]);
    }
});

test("a rejected delivery fails the whole tick", async () => {
    world.dispatched = dispatchView({ "agent-a": { fresh: [message], hasFloor: false, cursor: 4 } });
    world.prepared = () => ({ ok: false, reason: "stale_host" });
    await assert.rejects(ops.prepareHostDispatch(dispatch, host), { message: "delivery for agent-a rejected: stale_host" });
});

test("host verification lists every unchecked submission with the seat's accepted commits", async () => {
    const items = [
        workItem("a-1", "agent-a", "verified", { commitHash: "1".repeat(40) }),
        workItem("a-2", "agent-a", "awaiting_review", { commitHash: "2".repeat(40), hostVerified: false }),
        workItem("a-3", "agent-a", "awaiting_review", { commitHash: "3".repeat(40), hostVerified: true }),
        workItem("b-1", "agent-b", "awaiting_review", { commitHash: "4".repeat(40) }),
        workItem("b-2", "agent-b", "verified"),
    ];
    assert.deepEqual(ops.unverifiedWork(items).map((item) => [item.id, item.acceptedCommits]), [["a-2", ["1".repeat(40)]], ["b-1", []]]);
    await assert.rejects(ops.listUnverifiedWork({ sessionCode: "CN-TEST" }, seat()), { message: HOST_REQUIRED });
    assert.deepEqual(called(), []);
    world.campaign = null;
    assert.deepEqual(await ops.listUnverifiedWork({ sessionCode: "CN-TEST" }, host), { items: [] });
    world.campaign = baseCampaign;
    world.items = items;
    const listed = await ops.listUnverifiedWork({ sessionCode: "CN-TEST" }, host) as { campaignId: string; baseSha: string; items: unknown[] };
    assert.deepEqual([listed.campaignId, listed.baseSha, listed.items.length], [baseCampaign.id, baseCampaign.baseSha, 2]);
    world.session = null;
    assert.deepEqual(await ops.listUnverifiedWork({ sessionCode: "CN-TEST" }, host), { error: "unknown_session" });
});

test("supervision follows the campaign, then the closer's review, then the seat's own work", () => {
    const items = [workItem("a", "agent-a", "queued"), workItem("b", "agent-b", "awaiting_review")];
    const state = (status: CouncilCampaign["status"], agentName?: string, list = items) =>
        ops.supervisionState({ session: baseSession, campaign: { ...baseCampaign, status }, items: list, agentName });
    assert.equal(state("complete", "closer"), "complete");
    assert.equal(state("blocked", "agent-a"), "blocked");
    assert.equal(state("running", "closer"), "review");
    assert.equal(state("running", "agent-a"), "active");
    assert.equal(state("running", "agent-b"), "idle");
    assert.equal(state("running"), "idle");
    assert.equal(state("running", "closer", [items[0]]), "idle");
});

test("supervision reads are observer-gated before and after the session lookup", async () => {
    assert.equal((await ops.superviseCampaign({ sessionCode: "CN-TEST" }, { ...seat(), clientId: "invalid" })).kind, "denied");
    assert.deepEqual(called(), []);
    assert.equal((await ops.superviseCampaign({ sessionCode: "CN-TEST" }, seat("agent-a", OTHER_SESSION_ID))).kind, "denied");
    assert.deepEqual(called(), ["getSessionByCode"]);
    world.campaign = null;
    assert.deepEqual(await ops.superviseCampaign({ sessionCode: "CN-TEST" }, reader), { kind: "no_campaign" });
    world.campaign = baseCampaign;
    world.items = [workItem("a", "agent-a", "in_progress")];
    const status = await ops.superviseCampaign({ sessionCode: "CN-TEST", agentName: "agent-a" }, host);
    assert.equal(status.kind === "campaign" && status.state, "active");
});
