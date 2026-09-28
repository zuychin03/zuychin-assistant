import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://knowledge-fixture.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-gemini", NVIDIA_NIM_API_KEY: "fixture-nim",
    KNOWLEDGE_EMBEDDING_MODEL: "", CHAT_API_KEY: "fixture-chat",
});
interface Call { url: URL; method: string; body: Record<string, unknown> }
const calls: Call[] = [];
const unexpected: string[] = [];
const saved: { id: string; role: string; content: string }[] = [];
const deleted: string[] = [];
const hit = { document_id: "doc-1", chunk_id: "chunk-2", path: "plans/launch.md", title: "Launch plan", heading: "Release steps", content: "The launch date is Monday.", semantic_score: 0.9, lexical_score: 0.8, updated_at: "2026-09-28", trust: "trusted", kind: "document" };
let rows: Record<string, unknown>[] = [hit];
let retrievalError = "";
let projectError = false;
let danglingProject = false;
let abortAt = "";
let controller: AbortController | undefined;
let allowGeneration = false;
let newConversation = false;
let overrideReadError = false;

globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const headers = new Headers(init?.headers ?? request?.headers);
    calls.push({ url, method, body });
    if (url.hostname === "knowledge-fixture.supabase.co") {
        const table = url.pathname.replace("/rest/v1/", "");
        if (table === "messages" && method === "POST") {
            const id = `${body.role}-${saved.length + 1}`;
            saved.push({ id, role: body.role, content: body.content });
            if (abortAt === body.role) controller?.abort();
            return Response.json({ id });
        }
        if (table === "messages" && method === "DELETE") {
            deleted.push(url.searchParams.get("id")?.replace("eq.", "") ?? "");
            return Response.json([]);
        }
        if (table === "rpc/assistant_context_snapshot") return Response.json({ code: "PGRST202", message: "missing migration" }, { status: 404 });
        if (table === "rpc/hybrid_recall_knowledge_chunks") {
            if (abortAt === "recall") controller?.abort();
            return retrievalError ? Response.json({ message: retrievalError }, { status: 503 }) : Response.json(rows);
        }
        if (table === "conversations" && method === "GET") {
            const projectLookup = url.searchParams.get("select")?.includes("projects");
            if (projectLookup && projectError) return Response.json({ message: "lookup failed" }, { status: 503 });
            return Response.json({ id: "conversation", title: newConversation ? "New Chat" : "Existing chat",
                user_profile_id: "profile", project_id: "project-fixture", projects: danglingProject ? null : { id: "project-fixture", name: "Fixture", instructions: "" } });
        }
        if (table === "cron_state") return overrideReadError
            ? Response.json({ message: "partition state unavailable" }, { status: 503 })
            : Response.json({ value: { model: "nvidia/nemotron-3-embed-1b" } });
        if (table === "user_profiles") return Response.json({ id: "profile", display_name: "Fixture", system_prompt: "Fixture", preferences: {} });
        if (method === "HEAD") return new Response(null, { headers: { "Content-Range": "*/1" } });
        if (["messages", "conversations", "knowledge_links", "memories", "embeddings", "rpc/match_embeddings", "rpc/match_memories", "todos"].includes(table)) {
            return Response.json(headers.get("Accept")?.includes("vnd.pgrst.object+json") ? { id: "fixture-row" } : []);
        }
    }
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname === "/v1/embeddings") {
        return Response.json({ data: [{ embedding: Array.from({ length: 2048 }, () => 0.1) }] });
    }
    if (allowGeneration && url.hostname === "integrate.api.nvidia.com" && url.pathname === "/v1/chat/completions") {
        return new Response('data: {"choices":[{"delta":{"content":"Ordinary response"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }
    if (allowGeneration && url.hostname === "generativelanguage.googleapis.com") {
        return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: '{"operations":[]}' }] }, finishReason: "STOP" }] });
    }
    const description = `${method} ${url.origin}${url.pathname}`;
    unexpected.push(description);
    throw new Error(`Unexpected fixture request: ${description}`);
};

const { ragChat } = await import("../src/lib/ai/rag-service");
const { POST: chatPost } = await import("../src/app/api/chat/route");
const { POST: streamPost } = await import("../src/app/api/chat/stream/route");
const { NextRequest } = await import("next/server");
const base = { message: "launch date", channel: "web" as const, conversationId: "conversation", knowledgeOnly: true };
const recalls = () => calls.filter((call) => call.url.pathname.endsWith("/hybrid_recall_knowledge_chunks"));
function reset() {
    assert.deepEqual(unexpected, [], "No generation, helpers, tools or other transports may run");
    calls.length = 0; saved.length = 0; deleted.length = 0;
    rows = [hit]; retrievalError = ""; projectError = false; danglingProject = false; abortAt = ""; controller = undefined; newConversation = false;
}
let passed = 0;
async function check(name: string, run: () => Promise<void>) { reset(); await run(); assert.deepEqual(unexpected, []); passed++; console.log(`PASS ${name}`); }

await check("cold partition read fails closed, including a preceding non-strict failure", async () => {
    overrideReadError = true;
    const { refreshEmbeddingOverride } = await import("../src/lib/ai/embedding-override");
    await refreshEmbeddingOverride();
    assert.match((await ragChat(base)).reply, /unavailable/i);
    assert.equal(recalls().length, 0);
    assert.equal(calls.filter((call) => call.url.pathname.endsWith("/embeddings")).length, 0);
    overrideReadError = false;
});
await check("partition read retries and recovers after an unavailable cold read", async () => {
    assert.match((await ragChat(base)).reply, /The launch date is Monday/);
    assert(calls.some((call) => call.url.pathname.endsWith("/cron_state")));
});
await check("explicit mode overrides agent/thinking and returns source-linked excerpts and assistant ID", async () => {
    const result = await ragChat({ ...base, agent: true, thinking: true, search: true });
    assert.match(result.reply, /The launch date is Monday/);
    assert.match(result.reply, /\/knowledge\?/);
    assert.match(result.reply, /document=doc-1/);
    assert.match(result.reply, /chunk=chunk-2/);
    assert.match(result.reply, /Release steps/);
    assert(!result.reply.includes("vault://"));
    assert.equal(result.messageId, "assistant-2");
    assert.deepEqual(saved.map((message) => message.role), ["user", "assistant"]);
    assert.equal(recalls()[0].body.filter_project, "project-fixture");
    assert.equal(recalls()[0].body.filter_model, "nvidia/nemotron-3-embed-1b");
});
await check("unsupported results are labelled closest evidence", async () => {
    rows = [{ ...hit, title: "Gardening", heading: "Tools", content: "Plant tomatoes.", semantic_score: 0.01, lexical_score: 0 }];
    const result = await ragChat(base);
    assert.match(result.reply, /not contain enough evidence/);
    assert.match(result.reply, /Closest saved sources/);
});
await check("empty recall abstains", async () => {
    rows = []; assert.match((await ragChat(base)).reply, /could not find supporting/);
});
for (const error of ["schema cache unavailable", "database connection failed"]) {
    await check(`retrieval failure stays unavailable: ${error}`, async () => {
        retrievalError = error; assert.match((await ragChat(base)).reply, /unavailable/i);
    });
}
for (const dangling of [false, true]) {
    await check(`project lookup fails closed (${dangling ? "dangling join" : "read error"})`, async () => {
        danglingProject = dangling; projectError = !dangling;
        assert.match((await ragChat(base)).reply, /unavailable/i);
        assert.equal(recalls().length, 0);
        assert.equal(calls.filter((call) => call.url.pathname.endsWith("/embeddings")).length, 0);
    });
}
await check("new chat title is deterministic without a helper model", async () => {
    newConversation = true; await ragChat(base);
    assert(calls.some((call) => call.method === "PATCH" && call.body.title === "launch date"));
});
await check("saved Markdown cannot create images, HTML or disguised links", async () => {
    rows = [{ ...hit, content: "![steal](https://evil.invalid/pixel)\n[run](https://evil.invalid)\n<script>bad</script>\nhttps://evil.invalid" }];
    const result = await ragChat(base);
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: ReactMarkdown } = await import("react-markdown");
    const { default: remarkGfm } = await import("remark-gfm");
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: result.reply }));
    assert(!html.includes("<img"));
    assert(!html.includes("<script"));
    assert(html.includes("&lt;script&gt;bad&lt;/script&gt;"));
    assert(!html.includes(">run</a>"), "Saved Markdown must not create a disguised link");
    assert.match(html, /href="\/knowledge\?/);
});
for (const incompatible of [{ file: { name: "a.txt" } }, { imageBase64: "image" }, { resumeRunId: "run" }, { knowledgeOnly: "true" }]) {
    await check(`reject invalid input before side effects: ${Object.keys(incompatible)[0]}`, async () => {
        await assert.rejects(ragChat({ ...base, ...incompatible } as Parameters<typeof ragChat>[0]), /Knowledge only/);
        assert.equal(calls.length, 0);
    });
}
for (const stage of ["before", "user", "recall", "assistant"]) {
    await check(`cancellation at ${stage} removes saved messages`, async () => {
        controller = new AbortController(); abortAt = stage;
        if (stage === "before") controller.abort();
        await assert.rejects(ragChat({ ...base, signal: controller.signal }), { name: "AbortError" });
        assert.deepEqual(deleted.sort(), saved.map((message) => message.id).sort());
    });
}
for (const post of [chatPost, streamPost]) {
    await check("HTTP endpoint forwards explicit mode and returns the saved assistant ID", async () => {
        const response = await post(new NextRequest("https://fixture.invalid/api/chat", {
            method: "POST", headers: { authorization: "Bearer fixture-chat", "Content-Type": "application/json" }, body: JSON.stringify(base),
        }));
        assert.equal(response.status, 200);
        const responseText = await response.text();
        const body = post === chatPost ? JSON.parse(responseText)
            : JSON.parse(responseText.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
        assert.equal(body.messageId, "assistant-2");
        assert.equal(body.userMessageId, "user-1");
        assert.match(body.reply, /Saved source excerpts/);
    });
    for (const invalid of [{ file: { name: "file" } }, { resumeRunId: "run" }, { knowledgeOnly: "true" }]) {
        await check("HTTP endpoint rejects incompatible explicit mode before persistence", async () => {
            const response = await post(new NextRequest("https://fixture.invalid/api/chat", {
                method: "POST", headers: { authorization: "Bearer fixture-chat", "Content-Type": "application/json" }, body: JSON.stringify({ ...base, ...invalid }),
            }));
            assert.equal(response.status, 400);
            assert.equal(saved.length, 0);
        });
    }
}
await check("normal chat still generates and returns its assistant ID", async () => {
    allowGeneration = true;
    const result = await ragChat({ ...base, knowledgeOnly: false, channel: "telegram", provider: "nvidia-nim", model: "z-ai/glm-5.3-flash" });
    assert.equal(result.reply, "Ordinary response");
    assert.equal(result.messageId, "assistant-2");
    assert.equal(calls.filter((call) => call.url.pathname.endsWith("/chat/completions")).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
});
console.log(`${passed} knowledge-only production-path fixture checks passed.`);
