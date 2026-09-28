import assert from "node:assert/strict";
import type { Message } from "../src/lib/types";
import type { SavedConversationSummary } from "../src/lib/ai/conversation-context";

const modulePath = "../src/lib/ai/conversation-context.ts";
let implementation: typeof import("../src/lib/ai/conversation-context.ts") | undefined;
try { implementation = await import(modulePath); } catch { /* Initial red check. */ }
assert.ok(implementation?.buildConversationContext, "production incremental context builder must exist");

const { buildConversationContext } = implementation;
const scope = { conversationId: "conversation-a", channel: "web" as const, userId: "user-a", projectId: null };
const messages: Message[] = Array.from({ length: 15 }, (_, index) => ({
    id: `message-${String(index).padStart(3, "0")}`,
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    role: index % 2 ? "assistant" as const : "user" as const,
    channel: "web" as const,
    content: `Important fact ${index}`,
}));
let row: import("../src/lib/ai/conversation-context.ts").SavedConversationSummary | null = null;
const store: import("../src/lib/ai/conversation-context.ts").ConversationContextStore = {
    read: async () => ({ messages, revision: "1", summary: row, persistent: true, projectId: null }),
    isCurrent: async () => true,
    save: async (_scope, _snapshot, summary) => { row = summary; return true; },
};
let calls = 0;
const summarise = async ({ previous, messages: delta }: import("../src/lib/ai/conversation-context.ts").SummaryInput) => {
    calls++;
    return [previous, ...delta.map((m) => m.content)].filter(Boolean).join(" | ");
};
const first = await buildConversationContext({ scope, store, summarise });
assert.equal(first.status, "saved");
assert.equal(first.recentMessages.length, 5);
assert.match(first.historySection, /Important fact 0/);
assert.match(first.historySection, /Important fact 14/);
const second = await buildConversationContext({ scope, store, summarise });
assert.equal(second.status, "reused");
assert.equal(calls, 1, "reload must reuse saved summary without a model call");
console.log("Pass: saved summary reuses exact covered history after reload");

let passed = 1;
async function check(name: string, run: () => Promise<void>) {
    await run(); passed++; console.log(`Pass: ${name}`);
}
const saved = structuredClone(row) as unknown as SavedConversationSummary;
function fixture(initial: Message[] = messages, initialRow: SavedConversationSummary | null = saved) {
    let history = structuredClone(initial);
    let summary = structuredClone(initialRow);
    let revision = 1;
    let writes = 0;
    const storage: import("../src/lib/ai/conversation-context.ts").ConversationContextStore = {
        read: async () => ({ messages: structuredClone(history), revision: String(revision), summary, persistent: true, projectId: null }),
        isCurrent: async (_scope, snapshot) => snapshot.revision === String(revision),
        save: async (_scope, snapshot, next) => {
            if (snapshot.revision !== String(revision) || (snapshot.summary?.generation ?? 0) !== (summary?.generation ?? 0)) return false;
            summary = next; writes++; return true;
        },
    };
    return { storage, change: (next: typeof messages) => { history = next; revision++; }, get writes() { return writes; } };
}
await check("incremental updates consume only new older messages and keep remainder", async () => {
    const extra = Array.from({ length: 6 }, (_, i) => ({ ...messages[0], id: `new-${i}`, createdAt: new Date(1_800_000_000_000 + i).toISOString(), content: `New ${i}` }));
    const f = fixture([...messages, ...extra]);
    let deltaIds: string[] = [];
    const result = await buildConversationContext({ scope, store: f.storage, summarise: async (input) => {
        assert.equal(input.previous, saved.text); deltaIds = input.messages.map((m) => m.id); return "Updated attributed summary";
    } });
    assert.deepEqual(deltaIds, [...messages.slice(10), extra[0]].map((m) => m.id));
    assert.deepEqual(result.recentMessages.map((m) => m.id), extra.slice(1).map((m) => m.id));
});
await check("small increments reuse summary without losing unsummarised messages", async () => {
    const extra = { ...messages[14], id: "new-last", createdAt: "2029-01-01T00:00:00Z", content: "New unsummarised fact" };
    const result = await buildConversationContext({ scope, store: fixture([...messages, extra]).storage, summarise: async () => { throw Error("Must not summarise"); } });
    assert.equal(result.status, "reused"); assert.equal(result.recentMessages.length, 6);
    assert.match(result.historySection, /New unsummarised fact/);
});
await check("malformed persisted summary is rebuilt from history", async () => {
    const malformed = { version: 1, scope: implementation.contextScopeKey(scope), text: "Invalid persisted summary", generation: 1 } as SavedConversationSummary;
    let previous = "not-called";
    const result = await buildConversationContext({ scope, store: fixture(messages, malformed).storage, summarise: async (input) => { previous = input.previous; return "Rebuilt validated summary"; } });
    assert.equal(previous, ""); assert.match(result.historySection, /Rebuilt validated summary/);
});
await check("operational usage metadata cannot invalidate an unchanged summary", async () => {
    const history = messages.map((m) => ({ ...m, metadata: { replyTrace: { totalTokens: 20 }, backgroundUsage: { totalTokens: 5 } } }));
    const result = await buildConversationContext({ scope, store: fixture(history).storage, summarise: async () => { throw Error("Must reuse"); } });
    assert.equal(result.status, "reused");
});
for (const change of ["edit", "delete", "boundary", "metadata"] as const) {
    await check(`${change} invalidates the covered prefix`, async () => {
        const edited = structuredClone(messages);
        if (change === "edit") edited[0].content = "Corrected important fact";
        if (change === "delete") edited.splice(0, 1);
        if (change === "boundary") edited[9].id = "different-boundary";
        if (change === "metadata") Object.assign(edited[0], { metadata: { replyTo: { role: "user", content: "Changed quote" } } });
        let prior = "not-called";
        const result = await buildConversationContext({ scope, store: fixture(edited).storage, summarise: async (input) => { prior = input.previous; return "Rebuilt summary"; } });
        assert.equal(prior, ""); assert.equal(result.status, "saved");
    });
}
await check("branch/channel/profile scope cannot reuse another saved summary", async () => {
    for (const changedScope of [{ ...scope, conversationId: "branch-b" }, { ...scope, channel: "telegram" as const }, { ...scope, userId: "other-user" }]) {
        let prior = "not-called";
        await buildConversationContext({ scope: changedScope, store: fixture().storage, summarise: async (input) => { prior = input.previous; return "New scope"; } });
        assert.equal(prior, "");
    }
});
await check("project change during context build aborts stale project context", async () => {
    const storage = fixture().storage;
    storage.read = async () => ({ messages, revision: "2", summary: saved, persistent: true, projectId: "moved-project" });
    await assert.rejects(buildConversationContext({ scope, store: storage, summarise }), /project changed/);
});
await check("already-saved current message appears only in the live user turn", async () => {
    const result = await buildConversationContext({ scope, store: fixture(messages, null).storage, summarise: async () => null, currentMessageId: messages[14].id });
    assert.doesNotMatch(result.historySection, /Important fact 14/);
    assert.match(result.historySection, /Important fact 13/);
});
await check("equal timestamps use stable message IDs", async () => {
    const tied = messages.map((m) => ({ ...m, createdAt: messages[0].createdAt })).reverse();
    const result = await buildConversationContext({ scope, store: fixture(tied, null).storage, summarise: async () => null });
    assert.deepEqual(result.recentMessages.map((m) => m.id), messages.map((m) => m.id));
});
await check("failed summary retains every attributed message, including system role", async () => {
    const history = [...messages, { ...messages[14], id: "z", role: "system" as const, content: "Quoted system event" }];
    const result = await buildConversationContext({ scope, store: fixture(history, null).storage, summarise: async () => { throw Error("quota"); } });
    assert.equal(result.status, "verbatim");
    for (const m of history) assert.ok(result.historySection.includes(m.content));
    assert.match(result.historySection, /"role":"system"/);
});
await check("stale generation never publishes after an edit", async () => {
    const f = fixture(messages, null);
    let calls = 0;
    const result = await buildConversationContext({ scope, store: f.storage, summarise: async () => {
        if (++calls === 1) { f.change(messages.map((m, i) => i ? m : { ...m, content: "Corrected" })); return "STALE"; }
        return "Current corrected summary";
    } });
    assert.equal(f.writes, 1); assert.doesNotMatch(result.historySection, /STALE/); assert.equal(calls, 2);
});
await check("CAS conflict retries using the newly saved winner", async () => {
    const f = fixture(messages, null);
    const save = f.storage.save;
    let conflict = true;
    f.storage.save = async (...args) => {
        if (conflict) { conflict = false; await save(...args); return false; }
        return save(...args);
    };
    const result = await buildConversationContext({ scope, store: f.storage, summarise });
    assert.equal(result.status, "reused"); assert.equal(f.writes, 1);
});
await check("abort during summarisation cannot persist or return generated text", async () => {
    const f = fixture(messages, null), controller = new AbortController();
    await assert.rejects(buildConversationContext({ scope, store: f.storage, signal: controller.signal, summarise: async () => { controller.abort(); return "Cancelled"; } }), { name: "AbortError" });
    assert.equal(f.writes, 0);
});
await check("long chat includes history before the old 20-message fetch window", async () => {
    const history = Array.from({ length: 1000 }, (_, i) => ({ ...messages[0], id: `long-${String(i).padStart(5, "0")}`, content: `Fact ${i}`, createdAt: new Date(1_700_000_000_000 + i).toISOString() }));
    const seen: string[] = [];
    const result = await buildConversationContext({ scope, store: fixture(history, null).storage, summarise: async ({ messages: delta }) => { seen.push(...delta.map((m) => m.id)); return "Attributed key facts"; } });
    assert.deepEqual(seen, history.slice(0, -5).map((m) => m.id)); assert.equal(result.recentMessages.length, 5);
});
await check("oversized unsummarised fallback errors explicitly instead of dropping history", async () => {
    const history = messages.map((m) => ({ ...m, content: "X".repeat(10_000) }));
    await assert.rejects(buildConversationContext({ scope, store: fixture(history, null).storage, summarise: async () => null }), /no history was silently omitted/);
});
await check("stable prompt prefix retains project instructions before volatile context", async () => {
    const prefix = implementation.stableContextPrefix({ systemPrompt: "System instructions", persona: "Channel", project: { name: "A", instructions: "Project instructions" } });
    assert.equal(prefix, "System instructions\n\nChannel\n\n## Project: A\nProject instructions\n\n");
    assert.equal((prefix + "Clock A").slice(0, prefix.length), (prefix + "Clock B").slice(0, prefix.length));
});
const { createClient } = await import("@supabase/supabase-js");
const { createConversationContextStore } = await import("../src/lib/ai/conversation-context-store");
const transportCalls: { url: URL; body: Record<string, unknown> }[] = [];
let missing = true, dbRevision = "1", dbSummary: SavedConversationSummary | null = null;
const dbProject: string | null = null;
let dbMessages = messages.map((m) => ({ id: m.id, role: m.role, content: m.content, channel: m.channel, created_at: m.createdAt, metadata: {}, image_url: null }));
let loseCas = false;
const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    transportCalls.push({ url, body });
    if (url.pathname.endsWith("/rpc/assistant_context_snapshot")) {
        if (missing) return Response.json({ code: "PGRST202", message: "Missing function" }, { status: 404 });
        return Response.json({ revision: dbRevision, summary: dbSummary, project_id: dbProject, messages: dbMessages });
    }
    if (url.pathname.endsWith("/rpc/assistant_context_save")) {
        if (loseCas) { loseCas = false; dbRevision = String(Number(dbRevision) + 1); dbMessages[0] = { ...dbMessages[0], content: "CONCURRENT EDIT" }; return Response.json(false); }
        if (body.p_revision !== dbRevision || body.p_generation !== (dbSummary?.generation ?? 0)) return Response.json(false);
        dbSummary = body.p_summary; return Response.json(true);
    }
    if (url.pathname.endsWith("/conversations")) return Response.json({ project_id: dbProject });
    if (url.pathname.endsWith("/messages")) {
        const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 500);
        return Response.json(dbMessages.slice(offset, offset + limit));
    }
    throw Error(`Unexpected context transport ${url.pathname}`);
};
const client = createClient("https://context-fixture.invalid", "fixture-key", { global: { fetch: mockFetch }, auth: { persistSession: false } });
const transportStore = createConversationContextStore(client);
await check("missing migration paginates complete history and reports ephemeral summary", async () => {
    dbMessages = Array.from({ length: 1200 }, (_, i) => ({ ...dbMessages[0], id: `db-${String(i).padStart(5, "0")}`, content: `DB fact ${i}` }));
    const seen: string[] = [];
    const result = await buildConversationContext({ scope, store: transportStore, summarise: async ({ messages: delta }) => { seen.push(...delta.map((m) => m.id)); return "All batches accounted for"; } });
    assert.equal(result.status, "ephemeral");
    assert.deepEqual(seen, dbMessages.slice(0, -5).map((m) => m.id));
    const reads = transportCalls.filter((call) => call.url.pathname.endsWith("/messages"));
    assert.equal(reads.length, 6, "three pages plus conservative fingerprint verification");
    for (const { url } of reads) {
        assert.equal(url.searchParams.get("conversation_id"), "eq.conversation-a");
        assert.equal(url.searchParams.get("channel"), "eq.web");
        assert.equal(url.searchParams.get("user_profile_id"), "eq.user-a");
        assert.equal(url.searchParams.get("order"), "created_at.asc,id.asc");
    }
    assert.equal(transportCalls.filter((call) => call.url.pathname.endsWith("/assistant_context_save")).length, 0);
});
await check("unthreaded messages cannot mix project or other channel history", async () => {
    transportCalls.length = 0;
    await transportStore.read({ ...scope, conversationId: undefined });
    for (const { url } of transportCalls) {
        assert.equal(url.searchParams.get("conversation_id"), "is.null");
        assert.equal(url.searchParams.get("channel"), "eq.web");
        assert.equal(url.searchParams.get("user_profile_id"), "eq.user-a");
    }
});
await check("actual storage serialises boundary and CAS revision then reloads saved summary", async () => {
    missing = false; dbSummary = null; transportCalls.length = 0; dbMessages = dbMessages.slice(0, 15);
    const first = await buildConversationContext({ scope, store: transportStore, summarise: async () => "Persisted facts" });
    const second = await buildConversationContext({ scope, store: transportStore, summarise: async () => { throw Error("Must reuse"); } });
    assert.equal(first.status, "saved"); assert.equal(second.status, "reused");
    const request = transportCalls.find((call) => call.url.pathname.endsWith("/assistant_context_save"))!;
    assert.equal(request.body.p_revision, "1"); assert.equal(request.body.p_generation, 0);
    assert.deepEqual((request.body.p_summary as SavedConversationSummary).boundary, { id: dbMessages[9].id, createdAt: dbMessages[9].created_at, count: 10 });
});
await check("actual storage CAS rejects history changed after final validation", async () => {
    dbSummary = null; loseCas = true;
    const result = await buildConversationContext({ scope, store: transportStore, summarise: async ({ messages: delta }) => delta[0].content });
    assert.match(result.historySection, /CONCURRENT EDIT/);
    assert.equal((dbSummary as unknown as SavedConversationSummary).text, "CONCURRENT EDIT");
});
await check("atomic snapshot overflow is explicit", async () => {
    const original = dbMessages;
    dbMessages = Array.from({ length: 20_001 }, () => original[0]);
    try { await assert.rejects(transportStore.read(scope), /20,000-message/); }
    finally { dbMessages = original; }
});
await check("aborted storage read never invokes transport", async () => {
    transportCalls.length = 0;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(transportStore.read(scope, controller.signal), { name: "AbortError" });
    assert.equal(transportCalls.length, 0);
});
console.log(`${passed} conversation context cases passed`);
