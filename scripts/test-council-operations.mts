import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import * as scopes from "../src/lib/agents/scopes.ts";
import * as protocol from "../src/lib/council/protocol.ts";
import * as templates from "../src/lib/council/templates.ts";
import type { CouncilSession } from "../src/lib/council/store.ts";

// Convening is exercised directly over recording fakes, so every rule here holds
// for the chat tools, the online panel and anything added later.

const NOW = "2026-10-07T00:00:00.000Z";
const baseSession: CouncilSession = {
    id: "11111111-1111-4111-8111-111111111111", code: "CN-TEST", topic: "Fixture Council", brief: "Offline only",
    closerName: "agent-a", councilType: "debate", status: "open", round: 1, maxRounds: 4, maxMessages: 48, lastSeq: 0,
    lastMessageAt: NOW, quorumAt: NOW, floorHolder: null, floorGrantedAt: null, floorEpoch: 0, silentGrants: 0,
    verdict: null, openQuestions: [], archiveStatus: "pending", vaultPath: null, expiresAt: NOW, closedAt: null,
    createdAt: NOW, repoPath: null, baseBranch: null, protocolVersion: 3, baseSha: null, pausedAt: null,
    pausedTotalSeconds: 0, verdictProposedAt: null, standbyExpiresAt: null, continueCount: 0,
};

let open: CouncilSession[] = [];
const calls: { name: string; args: unknown[] }[] = [];
const called = () => calls.map((call) => call.name);

function boundary(name: string, answer: (...args: unknown[]) => unknown) {
    return async (...args: unknown[]) => {
        calls.push({ name, args });
        return answer(...args);
    };
}

const dependencies: Record<string, unknown> = {
    "@/lib/agents/scopes": scopes,
    "@/lib/council/host-contracts": {},
    "@/lib/council/protocol": protocol,
    "@/lib/council/templates": templates,
    "@/lib/council/store": {
        listOpenCouncils: boundary("listOpenCouncils", () => open),
        createCouncilSession: boundary("createCouncilSession", () => baseSession),
        listParticipants: boundary("listParticipants", () => []),
    },
};

// Evaluated in this realm so results compare structurally with local fixtures.
const ops = (() => {
    const exports = {};
    const source = readFileSync(new URL("../src/lib/council/operations.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const evaluate = runInThisContext(`(function (exports, require) {${compiled}
})`, { filename: "operations.ts" });
    evaluate(exports, (id: string) => {
        assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
        return dependencies[id];
    });
    return exports as typeof import("../src/lib/council/operations.ts");
})();

const owner = { scopes: [...scopes.OWNER_SCOPES] };
const host = { scopes: ["council:host"] };
const convene = {
    topic: "Fixture Council", brief: "Offline only", closerName: "agent-a",
    participants: [{ name: "agent-a", expertise: "x" }, { name: "agent-b", expertise: "y" }],
};

beforeEach(() => {
    calls.length = 0;
    open = [];
});

test("only an owner or the server's host identity may convene", async () => {
    for (const caller of [undefined, { scopes: ["knowledge:read"] }, { scopes: ["council:seat"] }, { scopes: [] }]) {
        assert.deepEqual(await ops.conveneCouncil(convene, caller), { kind: "denied", message: "This tool requires an owner or Council host credential." });
    }
    assert.deepEqual(called(), []);
    assert.equal((await ops.conveneCouncil(convene, host)).kind, "convened");
});

test("convene rejects a malformed roster or a non-debate type before reading or creating anything", async () => {
    const two = convene.participants;
    const cases: [{ name: string; expertise: string }[], string, unknown][] = [
        [[two[0]], "agent-a", { reason: "participant_count", count: 1 }],
        [Array.from({ length: 6 }, (_, i) => ({ name: `agent-${i}`, expertise: "x" })), "agent-0", { reason: "participant_count", count: 6 }],
        [two, "agent-c", { reason: "closer_not_participant", names: ["agent-a", "agent-b"] }],
        [[...two, { name: "agent-a", expertise: "z" }], "agent-a", { reason: "duplicate_names", names: ["agent-a", "agent-b", "agent-a"] }],
        [[...two, { name: protocol.MODERATOR_NAME, expertise: "z" }], "agent-a", { reason: "reserved_name", name: protocol.MODERATOR_NAME }],
    ];
    for (const [participants, closerName, rejection] of cases) {
        assert.deepEqual(await ops.conveneCouncil({ ...convene, participants, closerName }, owner), { kind: "rejected", rejection });
    }
    for (const councilType of ["code", "research", "audit", "debug"]) {
        assert.deepEqual(await ops.conveneCouncil({ ...convene, councilType }, owner), { kind: "rejected", rejection: { reason: "council_type", councilType } });
    }
    assert.deepEqual(called(), []);
});

test("convene stops at the open-Council cap and otherwise applies the debate template's budgets", async () => {
    open = [1, 2, 3].map((n) => ({ ...baseSession, code: `CN-000${n}` }));
    assert.deepEqual(await ops.conveneCouncil(convene, owner), { kind: "rejected", rejection: { reason: "open_limit", open } });
    assert.deepEqual(called(), ["listOpenCouncils"]);
    open = [];
    calls.length = 0;
    const result = await ops.conveneCouncil({ ...convene, maxRounds: 3 }, owner);
    assert.equal(result.kind, "convened");
    assert.deepEqual(called(), ["listOpenCouncils", "createCouncilSession", "listParticipants"]);
    const debate = templates.getCouncilTemplate("debate").defaults;
    assert.deepEqual(calls[1].args, [{
        topic: "Fixture Council", brief: "Offline only", closerName: "agent-a", participants: convene.participants,
        councilType: "debate", maxRounds: 3, maxMessages: debate.maxMessages, ttlMinutes: debate.ttlMinutes,
    }]);
});
