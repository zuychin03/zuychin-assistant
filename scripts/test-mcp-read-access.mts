import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as scopes from "../src/lib/agents/scopes.ts";

type Caller = { clientId?: string; scopes?: string[] };
type Result = { isError?: boolean; content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>, extra: { authInfo?: Caller }) => Promise<Result>;
const handlers = new Map<string, Handler>();
const io: { name: string; args: unknown[] }[] = [];
const now = "2026-09-30T00:00:00.000Z";
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
    "@/lib/agents/mcp-auth": {},
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
const seat = { clientId: "council-seat:10000000-0000-4000-8000-000000000001:agent:one", scopes: ["council:seat"] };
const knowledgeTools = [
    { name: "search_knowledge", args: { query: "fixture" }, expected: /private knowledge fixture/ },
    { name: "list_notes", args: { category: "study", limit: 3 }, expected: /private note fixture/ },
    { name: "vault_search", args: { query: "fixture" }, expected: /private vault search fixture/ },
    { name: "vault_read", args: { path: "index.md" }, expected: /private vault page fixture/ },
    { name: "get_recent_conversations", args: { limit: 3 }, expected: /private conversation fixture/ },
];
let passed = 0;
let failed = 0;
async function check(name: string, run: () => Promise<void>) {
    io.length = 0;
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
    assert.doesNotMatch(result.content.map(c => c.text).join("\n"), /private .* fixture/);
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

await check("the MCP server registers only the knowledge and vault tools", async () => {
    assert.deepEqual([...handlers.keys()].sort(), [
        "delete_note", "get_recent_conversations", "list_notes", "save_note", "search_knowledge",
        "update_note", "vault_ingest", "vault_read", "vault_search", "vault_write",
    ]);
});

console.log(`MCP read-access handler tests: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
