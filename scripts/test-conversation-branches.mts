import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let branch: typeof import("../src/lib/conversations/branches") | undefined;
try { branch = await import("../src/lib/conversations/branches"); } catch { /* Initial red check. */ }
assert.ok(branch?.parseForkRequest, "production fork validator must exist");
const ids = {
    conversationId: "11111111-1111-4111-8111-111111111111",
    messageId: "22222222-2222-4222-8222-222222222222",
    requestId: "33333333-3333-4333-8333-333333333333",
};
assert.deepEqual(branch.parseForkRequest(ids), ids);
assert.throws(() => branch!.parseForkRequest({ ...ids, messageId: "not-a-message" }), /messageId/);
assert.throws(() => branch!.parseForkRequest({ ...ids, userId: "other-user" }), /Only/);
assert.throws(() => branch!.parseForkRequest({ ...ids, title: "x".repeat(121) }), /120/);
const matches = [
    { id: "parent-future", content: "Future parent instruction", metadata: { source: "user_message", conversationId: ids.conversationId } },
    { id: "child", content: "Child history", metadata: { source: "user_message", conversationId: "child" } },
    { id: "legacy", content: "Unscoped history", metadata: { source: "user_message" } },
    { id: "note", content: "Saved note", metadata: { source: "note" } },
];
assert.deepEqual(branch.isolateBranchRecall(matches, "child", true).map((m) => m.id), ["child", "note"]);
assert.deepEqual(branch.isolateBranchRecall(matches, "child", false), matches);
console.log("Pass: fork validation and branch recall isolation");
const safe = branch.safeCopiedMetadata({
    artifacts: [{ id: "artifact", name: "Action", mime: "text/plain", kind: "document", size: 1 }],
    councilProposal: { topic: "Execute", brief: "Executable state", participants: [], closerName: "x", councilType: "x" },
    resumeRunId: "run", action: "execute", agentRun: { id: "run" }, knowledgeOnly: true,
    replyTo: { role: "user", content: "Quoted question" },
    replyTrace: { calls: [
        { providerId: "gemini-free", modelId: "model-a", purpose: "chat", status: "success", usage: { totalTokens: 100 }, id: "original-call" },
        { providerId: "paid", modelId: "failed-model", purpose: "chat", status: "auth" },
    ] },
}, { conversationId: ids.conversationId, messageId: ids.messageId });
assert.deepEqual(Object.keys(safe).sort(), ["branchOrigin", "historicalModels", "knowledgeOnly", "replyTo"]);
assert.deepEqual(safe.historicalModels, [{ providerId: "gemini-free", modelId: "model-a" }]);
assert.deepEqual(branch.safeCopiedMetadata(safe, { conversationId: "child", messageId: "copied" }).historicalModels, safe.historicalModels);
assert.doesNotMatch(JSON.stringify(safe), /original-call|totalTokens|councilProposal|resumeRunId|artifacts/);
console.log("Pass: copied metadata retains quoted evidence and model identity without executable actions or duplicate observations");

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://branches-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat", GEMINI_API_KEY: "fixture-gemini",
    NVIDIA_NIM_API_KEY: "fixture-nim",
});
const userId = "44444444-4444-4444-8444-444444444444", childId = "55555555-5555-4555-8555-555555555555";
const row = { id: childId, title: "Alternative approach", project_id: "project-a", parent_conversation_id: ids.conversationId,
    parent_message_id: ids.messageId, copied_count: 3, created_at: "2026-09-28T01:00:00Z" };
let calls: { path: string; body: Record<string, unknown> }[] = [];
let failure: string | null = null;
let missingProfile = false;
let branchLookupFailure = false;
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname === "/v1/embeddings") return Response.json({ data: [{ embedding: Array.from({ length: 2048 }, () => 0.1) }] });
    assert.equal(url.hostname, "branches-fixture.supabase.co");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/user_profiles")) return Response.json(missingProfile ? null : { id: userId });
    if (url.pathname.endsWith("/cron_state")) return Response.json({ value: { model: "nvidia/nemotron-3-embed-1b" } });
    if (url.pathname.endsWith("/rpc/hybrid_match_knowledge")) return Response.json(matches.map((match) => ({ ...match, metadata: { ...match.metadata, ...(match.id === "child" ? { conversationId: childId } : {}) } })));
    if (url.pathname.endsWith("/messages")) {
        assert.equal(url.searchParams.get("conversation_id"), `eq.${childId}`);
        return Response.json([{ id: "child", role: "user", content: "Child history", channel: "web", created_at: row.created_at }]);
    }
    if (failure) return Response.json({ code: failure, message: "Fixture rejection" }, { status: 400 });
    if (url.pathname.endsWith("/rpc/assistant_fork_conversation")) return Response.json(row);
    if (url.pathname.endsWith("/rpc/assistant_related_conversations")) return Response.json({ current: row, related: [{ ...row, id: ids.conversationId, parent_conversation_id: null, parent_message_id: null, copied_count: 0 }] });
    if (url.pathname.endsWith("/rpc/assistant_compare_conversations")) {
        return Response.json({ left: { conversation: { ...row, id: ids.conversationId }, messages: [{ id: ids.messageId, content: "Original", role: "user", channel: "web", created_at: row.created_at }] },
            right: { conversation: row, messages: [{ id: "copied", content: "Original", role: "user", channel: "web", created_at: row.created_at, metadata: { branchOrigin: { conversationId: ids.conversationId, messageId: ids.messageId, copied: true } } }] } });
    }
    if (url.pathname.endsWith("/conversations") && (init?.method ?? "GET") === "POST") return Response.json({ id: childId, title: "New Chat" });
    if (url.pathname.endsWith("/assistant_conversation_branches")) return branchLookupFailure ? Response.json({ code: "XX000", message: "Fixture branch lookup failure" }, { status: 503 }) : Response.json({ conversation_id: childId });
    throw Error(`Unexpected branch transport: ${url.pathname}`);
};
const routes = await import("../src/app/api/conversations/branches/route");
const compare = await import("../src/app/api/conversations/compare/route");
const normal = await import("../src/app/api/conversations/route");
const { NextRequest } = await import("next/server");
const { createBranchStore } = await import("../src/lib/conversations/branch-store");
const { supabaseAdmin } = await import("../src/lib/supabase");
function req(path: string, method = "GET", body?: unknown, authorised = true) {
    return new NextRequest(`https://fixture.invalid${path}`, { method,
        headers: { ...(authorised ? { authorization: "Bearer fixture-chat" } : {}), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
let passed = 2;
async function check(name: string, run: () => Promise<void>) {
    calls = []; failure = null; missingProfile = false; branchLookupFailure = false; await run(); passed++; console.log(`Pass: ${name}`);
}
await check("all branch routes authenticate before database access", async () => {
    assert.equal((await routes.POST(req("/api/conversations/branches", "POST", ids, false))).status, 401);
    assert.equal((await routes.GET(req(`/api/conversations/branches?conversationId=${ids.conversationId}`, "GET", undefined, false))).status, 401);
    assert.equal((await compare.GET(req(`/api/conversations/compare?left=${ids.conversationId}&right=${childId}`, "GET", undefined, false))).status, 401);
    assert.equal(calls.length, 0);
});
await check("fork uses server profile and returns lineage without caching", async () => {
    const response = await routes.POST(req("/api/conversations/branches", "POST", { ...ids, title: "  Alternative approach  " }));
    assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store");
    const { conversation } = await response.json(); assert.equal(conversation.id, childId); assert.equal(conversation.copiedCount, 3);
    assert.equal(conversation.parentMessageId, ids.messageId); assert.equal(conversation.projectId, "project-a");
    assert.deepEqual(calls[1].body, { p_conversation_id: ids.conversationId, p_message_id: ids.messageId, p_request_id: ids.requestId, p_user_id: userId, p_title: "Alternative approach" });
});
await check("retry preserves the idempotency key", async () => {
    const first = await (await routes.POST(req("/api/conversations/branches", "POST", ids))).json();
    const second = await (await routes.POST(req("/api/conversations/branches", "POST", ids))).json();
    assert.equal(first.conversation.id, second.conversation.id);
    assert(calls.filter((call) => call.path.endsWith("assistant_fork_conversation")).every((call) => call.body.p_request_id === ids.requestId));
});
await check("caller cannot override user, project, copied metadata or branch ID", async () => {
    for (const extra of [{ userId }, { projectId: "foreign" }, { metadata: { councilProposal: {} } }, { branchId: childId }]) {
        assert.equal((await routes.POST(req("/api/conversations/branches", "POST", { ...ids, ...extra }))).status, 400);
    }
    assert.equal(calls.length, 0);
});
await check("invalid or oversized requests fail before database access", async () => {
    for (const value of [null, [], {}, { ...ids, messageId: "" }, { ...ids, title: "x".repeat(121) }, { ...ids, title: " " }]) {
        assert.equal((await routes.POST(req("/api/conversations/branches", "POST", value))).status, 400);
    }
    assert.equal(calls.length, 0);
});
for (const [code, status] of [["PGRST202", 503], ["42501", 404], ["P0002", 404], ["22023", 409], ["54000", 413]] as const) {
    await check(`RPC ${code} maps to safe HTTP ${status}`, async () => {
        failure = code; const response = await routes.POST(req("/api/conversations/branches", "POST", ids)); assert.equal(response.status, status);
        assert.doesNotMatch(JSON.stringify(await response.json()), /Fixture rejection/);
    });
}
await check("missing profile cannot fork", async () => {
    missingProfile = true; assert.equal((await routes.POST(req("/api/conversations/branches", "POST", ids))).status, 404);
    assert.equal(calls.length, 1);
});
await check("related navigation and comparison remain read-only", async () => {
    const navigation = await routes.GET(req(`/api/conversations/branches?conversationId=${childId}`));
    assert.equal(navigation.status, 200); assert.equal((await navigation.json()).related[0].id, ids.conversationId);
    const response = await compare.GET(req(`/api/conversations/compare?left=${ids.conversationId}&right=${childId}`));
    assert.equal(response.status, 200); const data = await response.json();
    assert.equal(data.right.messages[0].metadata.branchOrigin.copied, true);
    assert(calls.every((call) => !call.path.includes("fork")));
});
await check("comparison requires two different valid IDs", async () => {
    assert.equal((await compare.GET(req(`/api/conversations/compare?left=${childId}&right=${childId}`))).status, 400);
    assert.equal((await compare.GET(req("/api/conversations/compare?left=invalid&right=bad"))).status, 400);
    assert.equal(calls.length, 0);
});
await check("new normal conversations persist server-resolved ownership", async () => {
    assert.equal((await normal.POST(req("/api/conversations", "POST", {}, false))).status, 401);
    assert.equal(calls.length, 0);
    const response = await normal.POST(req("/api/conversations", "POST", {})); assert.equal(response.status, 200);
    assert.equal(calls.find((call) => call.path.endsWith("/conversations"))?.body.user_profile_id, userId);
});
await check("branch recognition fails closed on database errors", async () => {
    const store = createBranchStore(supabaseAdmin);
    assert.equal(await store.isBranch(childId, userId), true);
    failure = "XX000"; await assert.rejects(store.isBranch(childId, userId), /temporarily unavailable/);
});
await check("aborted fork cannot invoke transport", async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createBranchStore(supabaseAdmin).fork(ids, userId, controller.signal), { name: "AbortError" });
    assert.equal(calls.length, 0);
});
await check("production history and knowledge tools cannot disclose parent-future embeddings in a branch", async () => {
    const { executeTool } = await import("../src/lib/ai/mcp-service");
    const { getEmbeddingRef } = await import("../src/lib/ai/embeddings");
    const embRef = getEmbeddingRef("nvidia/nemotron-3-embed-1b");
    for (const name of ["search_history", "search_knowledge"]) {
        const result = await executeTool(name, { query: "history" }, embRef, { conversationId: childId, userProfileId: userId, freeOnly: true });
        assert.match(result, /Child history/); assert.doesNotMatch(result, /Future parent instruction|Unscoped history/);
        if (name === "search_knowledge") assert.match(result, /Saved note/);
    }
    assert.match(await executeTool("get_recent_conversations", { limit: 10 }, embRef, { conversationId: childId, userProfileId: userId, freeOnly: true }), /Child history/);
    branchLookupFailure = true;
    const refused = await executeTool("search_history", { query: "history" }, embRef, { conversationId: childId, userProfileId: userId, freeOnly: true });
    assert.match(refused, /temporarily unavailable/); assert.doesNotMatch(refused, /Future parent instruction/);
});
await check("read-only comparison renders copied provenance, quote, matching prefix and continuation links", async () => {
    const require = createRequire(import.meta.url);
    const oldLoader = require.extensions[".css"];
    require.extensions[".css"] = (module) => { module.exports = { __esModule: true, default: new Proxy({}, { get: (_target, key) => String(key) }) }; };
    try {
        const { BranchComparisonContent } = await import("../src/app/conversations/branch-comparison");
        const source = { id: ids.messageId, role: "user" as const, channel: "web" as const, content: "<script>bad()</script>", createdAt: row.created_at };
        const conversation = { id: ids.conversationId, title: "Original", projectId: "project-a", parentConversationId: null, parentMessageId: null, copiedCount: 0, createdAt: row.created_at };
        const result = { left: { conversation, messages: [source] }, right: { conversation: { ...conversation, id: childId, title: "Alternative", parentConversationId: ids.conversationId },
            messages: [{ ...source, id: "copied" }, { ...source, id: "answer", role: "assistant" as const, content: "Alternative answer", metadata: safe }] } };
        assert.equal(branch!.matchingPrefixCount(result.left.messages, result.right.messages), 1);
        const html = renderToStaticMarkup(createElement(BranchComparisonContent, { result }));
        assert.match(html, /<details/); assert.match(html, /matching earlier/); assert.match(html, /Continue here/);
        assert.match(html, /gemini-free \/ model-a/); assert.match(html, /Quoted question/); assert.match(html, /Alternative answer/);
        assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|councilProposal|resumeRunId|original-call/);
        assert.equal(branch!.matchingPrefixCount([source], [{ ...source, metadata: { replyTo: { role: "user", content: "Different quotation" } } }]), 0);
    } finally {
        if (oldLoader) require.extensions[".css"] = oldLoader;
        else delete require.extensions[".css"];
    }
});
console.log(`${passed} conversation branch cases passed`);
