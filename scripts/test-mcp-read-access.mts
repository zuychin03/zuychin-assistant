import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as scopes from "../src/lib/agents/scopes.ts";
import * as protocol from "../src/lib/council/protocol.ts";
import * as render from "../src/lib/council/render.ts";
import * as templates from "../src/lib/council/templates.ts";
import * as hostContracts from "../src/lib/council/host-contracts.ts";
import * as writeIdentity from "../src/lib/council/write-identity.ts";
import * as v3 from "../src/lib/council/v3.ts";
import type { CouncilSession, CouncilMessage } from "../src/lib/council/store.ts";
import type { CouncilCampaign, CouncilWorkItem } from "../src/lib/council/campaign.ts";

type Caller = { clientId?: string; scopes?: string[] };
type Result = { isError?: boolean; content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>, extra: { authInfo?: Caller }) => Promise<Result>;
const handlers = new Map<string, Handler>();
const io: { name: string; args: unknown[] }[] = [];
const sessionId = "10000000-0000-4000-8000-000000000001";
const otherSessionId = "20000000-0000-4000-8000-000000000002";
const now = "2026-09-30T00:00:00.000Z";
const session: CouncilSession = {
    id: sessionId, code: "CN-ABCD", topic: "Fixture Council", brief: "Offline only", closerName: "closer", councilType: "code",
    status: "open", round: 1, maxRounds: 3, maxMessages: 50, lastSeq: 1, lastMessageAt: now,
    quorumAt: now, floorHolder: null, floorGrantedAt: null, floorEpoch: 0, silentGrants: 0,
    verdict: null, openQuestions: [], archiveStatus: "pending", vaultPath: null,
    expiresAt: now, closedAt: null, createdAt: now, repoPath: "/fixture", baseBranch: "main",
    protocolVersion: 3, baseSha: "a".repeat(40), pausedAt: null, pausedTotalSeconds: 0,
    verdictProposedAt: null, standbyExpiresAt: null, continueCount: 0,
};
const messages: CouncilMessage[] = [{
    seq: 1, round: 1, speaker: "other-seat", role: "agent", addressedTo: "all", intent: "propose",
    replyToSeq: null, body: "private transcript fixture", answered: false, createdAt: now, executionId: null,
}];
const campaign: CouncilCampaign = {
    id: "campaign-fixture", sessionId, status: "running", repoPath: "/fixture", baseBranch: "main", createdAt: now,
    completedAt: null, integratorAgent: null, integrationBranch: null, integrationStatus: null, integrationReport: null,
    integrationCheckedAt: null, baseSha: "a".repeat(40), verificationProfile: "offline", integrationManifest: null,
    manifestFrozenAt: null, integrationTipSha: null,
};
const items: CouncilWorkItem[] = [{
    id: "work-fixture", campaignId: campaign.id, sequence: 1, agentName: "other-seat", title: "private work fixture",
    instructions: "Offline only", acceptanceCriteria: [], status: "in_progress", heartbeatAt: now, attempts: 1,
    progress: null, commitHash: null, verification: null, hostVerified: null, hostVerification: null, hostCheckedAt: null,
    declaredPaths: [], blockedReason: null, startedAt: now, completedAt: null, reviewedAt: null, branchName: null,
    acceptedCommitSha: null, verificationProfile: "offline", verificationRunId: null, dependencies: [],
    submittedExecutionId: null, acceptedExecutionId: null,
}];
let campaignExists = true;
function boundary(name: string, value: unknown) {
    return (...args: unknown[]) => { io.push({ name, args: structuredClone(args) }); return value; };
}
const dependencies: Record<string, unknown> = {
    "zod": { z },
    "next/server": { after: () => { throw new Error("Unexpected background work"); } },
    "mcp-handler": {
        createMcpHandler: (register: (server: { registerTool: (name: string, metadata: unknown, handler: Handler) => void }) => void) => {
            register({ registerTool: (name, _metadata, handler) => { handlers.set(name, handler); } });
            return () => undefined;
        },
        withMcpAuth: (handler: unknown) => handler,
    },
    "@/lib/agents/scopes": scopes,
    "@/lib/council/write-identity": writeIdentity,
    "@/lib/council/protocol": protocol,
    "@/lib/council/render": render,
    "@/lib/council/templates": templates,
    "@/lib/council/host-contracts": hostContracts,
    "@/lib/council/v3": v3,
    "@/lib/ai/embeddings": { getEmbeddingRef: boundary("getEmbeddingRef", { model: { id: "fixture" } }), embedText: boundary("embedText", [0.1]) },
    "@/lib/ai/embedding-override": { refreshEmbeddingOverride: boundary("refreshEmbeddingOverride", undefined) },
    "@/lib/db": {
        hybridSearchKnowledge: boundary("hybridSearchKnowledge", [{ id: "note-fixture", content: "private knowledge fixture", metadata: {} }]),
        searchEmbeddings: boundary("searchEmbeddings", []),
        listKnowledgeNotes: boundary("listKnowledgeNotes", [{ id: "note-fixture", content: "private note fixture", metadata: {}, createdAt: now }]),
        getRecentMessages: boundary("getRecentMessages", [{ role: "user", channel: "web", content: "private conversation fixture" }]),
    },
    "@/lib/vault/store": {
        searchVaultPages: boundary("searchVaultPages", [{ path: "index.md", category: "study", similarity: 1, title: "private vault search fixture", summary: "Offline" }]),
        vaultEmbeddingRef: boundary("vaultEmbeddingRef", { model: { id: "fixture" } }),
    },
    "@/lib/vault/github": { getVaultConfig: boundary("getVaultConfig", {}), getFile: boundary("getFile", { text: "private vault page fixture" }) },
    "@/lib/vault/ingest": { VAULT_CATEGORIES: ["study"] },
    "@/lib/council/store": {
        getSessionByCode: (code: string) => {
            io.push({ name: "getSessionByCode", args: [code] });
            return code === "CN-ABCD" ? session : code === "CN-EFGH" ? { ...session, id: otherSessionId, code } : null;
        },
        readTranscript: boundary("readTranscript", messages),
    },
    "@/lib/council/campaign": {
        getCampaignForSession: (id: string) => { io.push({ name: "getCampaignForSession", args: [id] }); return campaignExists ? campaign : null; },
        listCampaignWorkItems: boundary("listCampaignWorkItems", items),
    },
    "@/lib/council/wait": {}, "@/lib/council/close": {}, "@/lib/council/moderator": {},
    "@/lib/council/seat-keys": {}, "@/lib/agents/mcp-auth": {}, "@/lib/council/service": {},
};
function loadSource(path: string): unknown {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    runInNewContext(compiled, {
        exports, process: { env: {} },
        require: (id: string) => {
            if (id === "@/lib/agents/read-access") return loadSource("../src/lib/agents/read-access.ts");
            if (id === "./scopes") return scopes;
            assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
            return dependencies[id];
        },
    }, { filename: path });
    return exports;
}
loadSource("../src/app/api/mcp/[transport]/route.ts");

const named = (rights: string[]): Caller => ({ clientId: "agent:client-fixture:reader", scopes: rights });
const host = { clientId: "council-host", scopes: ["council:host"] };
const seat = { clientId: `council-seat:${sessionId}:agent:one`, scopes: ["council:seat"] };
const knowledgeTools = [
    { name: "search_knowledge", args: { query: "fixture" }, expected: /private knowledge fixture/ },
    { name: "list_notes", args: { category: "study", limit: 3 }, expected: /private note fixture/ },
    { name: "vault_search", args: { query: "fixture" }, expected: /private vault search fixture/ },
    { name: "vault_read", args: { path: "index.md" }, expected: /private vault page fixture/ },
    { name: "get_recent_conversations", args: { limit: 3 }, expected: /private conversation fixture/ },
];
const observerTools = ["council_transcript", "council_work_status"];
let passed = 0;
let failed = 0;
async function check(name: string, run: () => Promise<void>) {
    io.length = 0;
    campaignExists = true;
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function invoke(name: string, caller: Caller | undefined, args: Record<string, unknown>) {
    const handler = handlers.get(name);
    assert(handler, `Missing registered handler: ${name}`);
    return handler(args, { authInfo: caller });
}
function assertDenied(result: Result, expectedIo: string[] = []) {
    assert.equal(result.isError, true, "read must return an explicit authorisation error");
    assert.doesNotMatch(result.content.map(c => c.text).join("\n"), /private .* fixture|SUPERVISE:|TRANSCRIPT/);
    assert.deepEqual(io.map(call => call.name), expectedIo, "denied reads must not reach data or provider boundaries");
}

for (const tool of knowledgeTools) {
    for (const [label, caller] of [
        ["missing auth", undefined], ["missing scopes", { clientId: "agent:client-fixture:reader" }],
        ["empty scopes", named([])], ["knowledge write only", named(["knowledge:write"])], ["owner without knowledge scope", named(["council:owner"])],
        ["notes write only", named(["notes:write"])],
        ["vault write only", named(["vault:write"])], ["host", host], ["seat", seat],
    ] as const) await check(`${tool.name} denies ${label} before I/O`, async () => {
        assertDenied(await invoke(tool.name, caller, tool.args));
    });
    for (const [label, caller] of [
        ["named reader", named(["knowledge:read"])], ["named notes writer", named(["knowledge:read", "notes:write"])],
        ["named vault writer", named(["knowledge:read", "vault:write"])], ["owner", named([...scopes.OWNER_SCOPES])],
    ] as const) await check(`${tool.name} allows ${label}`, async () => {
        const result = await invoke(tool.name, caller, tool.args);
        assert.notEqual(result.isError, true);
        assert.match(result.content[0].text, tool.expected);
        assert(io.length > 0);
    });
}

for (const tool of observerTools) {
    const args = { sessionCode: "CN-ABCD", agentName: "other-seat", fromSeq: 1, limit: 7 };
    for (const [label, caller] of [
        ["missing auth", undefined], ["missing scopes", { clientId: "agent:client-fixture:reader" }],
        ["empty scopes", named([])], ["notes write only", named(["notes:write"])], ["vault write only", named(["vault:write"])],
    ] as const) await check(`${tool} denies ${label} before session lookup`, async () => {
        assertDenied(await invoke(tool, caller, args));
    });
    for (const clientId of [undefined, "", "agent:client-fixture:reader", "council-seat:", `council-seat:${sessionId}`,
        `council-seat:${sessionId}:`, `council-seat:${sessionId}:   `, "council-seat::agent", "council-seat:not-a-uuid:agent"]) {
        await check(`${tool} denies malformed seat identity ${JSON.stringify(clientId)}`, async () => {
            assertDenied(await invoke(tool, { clientId, scopes: ["council:seat"] }, args));
        });
    }
    for (const [label, caller] of [
        ["named reader", named(["knowledge:read"])], ["owner without knowledge scope", named(["council:owner"])],
        ["dedicated host", host], ["same-Council seat with colon name", seat],
    ] as const) await check(`${tool} allows ${label} to observe another seat`, async () => {
        const result = await invoke(tool, caller, args);
        assert.notEqual(result.isError, true);
        assert.match(result.content[0].text, tool === "council_transcript" ? /private transcript fixture/ : /SUPERVISE: active\n[\s\S]*private work fixture/);
        assert.deepEqual(io.map(call => call.name), tool === "council_transcript"
            ? ["getSessionByCode", "readTranscript"] : ["getSessionByCode", "getCampaignForSession", "listCampaignWorkItems"]);
        if (tool === "council_transcript") assert.deepEqual(io[1].args, [{ sessionId, fromSeq: 1, limit: 7 }]);
        else assert.deepEqual(io[1].args, [sessionId]);
    });
    await check(`${tool} blocks a seat from another Council before reading content`, async () => {
        assertDenied(await invoke(tool, seat, { ...args, sessionCode: "CN-EFGH" }), ["getSessionByCode"]);
    });
    for (const extraScope of ["knowledge:read", "council:owner", "council:host"]) {
        await check(tool + " keeps seat binding with added " + extraScope, async () => {
            assertDenied(await invoke(tool, { ...seat, scopes: ["council:seat", extraScope] }, { ...args, sessionCode: "CN-EFGH" }), ["getSessionByCode"]);
        });
        await check(tool + " denies malformed seat with added " + extraScope, async () => {
            assertDenied(await invoke(tool, { clientId: "invalid", scopes: ["council:seat", extraScope] }, args));
        });
    }
    for (const caller of [named(["knowledge:read"]), host, seat]) await check(`${tool} preserves unknown Council response for authorised readers`, async () => {
        const result = await invoke(tool, caller, { ...args, sessionCode: "CN-ZZZZ" });
        assert.notEqual(result.isError, true);
        assert.match(result.content[0].text, /CN-ZZZZ/);
        assert.doesNotMatch(result.content[0].text, /private .* fixture/);
        assert.deepEqual(io.map(call => call.name), ["getSessionByCode"]);
    });
}
await check("host work status preserves no_campaign release signal", async () => {
    campaignExists = false;
    const result = await invoke("council_work_status", host, { sessionCode: "CN-ABCD", agentName: "other-seat" });
    assert.match(result.content[0].text, /^SUPERVISE: no_campaign\n/);
    assert.deepEqual(io.map(call => call.name), ["getSessionByCode", "getCampaignForSession"]);
});

console.log(`MCP read-access handler tests: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
