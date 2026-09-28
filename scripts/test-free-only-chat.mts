import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://free-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-paid", GEMINI_FREE_API_KEY: "fixture-free", NVIDIA_NIM_API_KEY: "fixture-nim", CHAT_API_KEY: "fixture-chat",
    OPENROUTER_API_KEY: "", KILO_API_KEY: "", OPENCODE_ZEN_API_KEY: "", TOKENROUTER_API_KEY: "", DEEPSEEK_API_KEY: "", KNOWLEDGE_EMBEDDING_MODEL: "",
});
type Call = { url: URL; method: string; body: Record<string, unknown>; key: string | null };
const calls: Call[] = [], unexpected: string[] = [];
let prefs: Record<string, unknown> = { freeOnly: true };
let profileError = false, allowPaid = false, generationError = false, truncated = false, flipPolicyOnReply = false;
let historyLength = 0, nextTool = "", abortAt = "", id = 0;
let controller: AbortController | undefined;
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const headers = new Headers(init?.headers ?? request?.headers);
    const key = headers.get("x-goog-api-key") ?? headers.get("authorization") ?? url.searchParams.get("key");
    calls.push({ url, method, body, key });
    if (url.hostname === "free-fixture.supabase.co") {
        const table = url.pathname.replace("/rest/v1/", "");
        if (table === "rpc/assistant_context_snapshot") return Response.json({ code: "PGRST202", message: "Summary migration not applied in fixture" }, { status: 404 });
        if (table === "user_profiles") return profileError ? Response.json({ message: "unavailable" }, { status: 503 }) : Response.json({ id: "profile", system_prompt: "Fixture", preferences: prefs });
        if (table === "cron_state") return Response.json({ value: { model: "nvidia/nemotron-3-embed-1b" } });
        if (table === "messages" && method === "POST") {
            if (body.role === "assistant" && flipPolicyOnReply) prefs = { freeOnly: false };
            return Response.json({ id: `${body.role}-${++id}` });
        }
        if (table === "messages" && method === "GET") return Response.json(Array.from({ length: historyLength }, (_, i) => ({ id: String(i), role: i % 2 ? "assistant" : "user", content: "Earlier discussion", channel: "web", created_at: "2026-09-28T01:00:00Z" })));
        if (table === "conversations") return Response.json({ id: "conversation", title: "New Chat", project_id: null, projects: null });
        if (table === "agent_runs") return Response.json({ id: "run", root_run_id: "run", events: [], plan: [], status: "interrupted" });
        if (method === "HEAD") return new Response(null, { headers: { "Content-Range": "*/1" } });
        if (["messages", "custom_skills", "knowledge_links", "memories", "embeddings", "rpc/match_embeddings", "rpc/match_memories", "rpc/hybrid_recall_knowledge_chunks", "todos", "agent_mutations"].includes(table)) return Response.json([]);
    }
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname === "/v1/embeddings") {
        if (abortAt === "embedding") { controller?.abort(); throw new DOMException("cancelled", "AbortError"); }
        return Response.json({ data: [{ embedding: Array.from({ length: 2048 }, () => 0.1) }] });
    }
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname === "/v1/chat/completions") {
        if (generationError) return Response.json({ error: "fixture failure" }, { status: 400 });
        if (abortAt === "generation") { controller?.abort(); throw new DOMException("cancelled", "AbortError"); }
        return new Response('data: {"choices":[{"delta":{"content":"Fixture answer"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.hostname === "generativelanguage.googleapis.com" && (key === "fixture-free" || (allowPaid && key === "fixture-paid"))) {
        if (generationError) return Response.json({ error: { message: "fixture failure", code: 400 } }, { status: 400 });
        const parts = nextTool ? [{ functionCall: { name: nextTool, args: { query: "fixture", content: "fixture" } } }] : [{ text: "Fixture answer" }]; nextTool = "";
        const streaming = url.pathname.includes("streamGenerateContent");
        const finishReason = streaming && truncated ? "MAX_TOKENS" : "STOP"; if (streaming) truncated = false;
        const payload = { candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata: { totalTokenCount: 5, promptTokenCount: 3, candidatesTokenCount: 2 } };
        if (body.generationConfig && (body.generationConfig as Record<string, unknown>).responseMimeType === "application/json") payload.candidates[0].content.parts = [{ text: '{"operations":[]}' }];
        return streaming ? new Response("data: " + JSON.stringify(payload) + "\n\n", { headers: { "Content-Type": "text/event-stream" } }) : Response.json(payload);
    }
    const description = `${method} ${url.origin}${url.pathname} (${key ?? "no key"})`;
    unexpected.push(description); throw new Error(`Unexpected or paid fixture request: ${description}`);
};
const { ragChat } = await import("../src/lib/ai/rag-service");
const { runWorker } = await import("../src/lib/ai/agent/worker");
const { executeTool } = await import("../src/lib/ai/mcp-service");
const { getEmbeddingRef } = await import("../src/lib/ai/embeddings");
const { setEmbeddingOverride } = await import("../src/lib/ai/embedding-override");
const { listProvidersPublic } = await import("../src/lib/ai/providers");
const { POST: chatPost } = await import("../src/app/api/chat/route");
const { POST: streamPost } = await import("../src/app/api/chat/stream/route");
const { POST: ttsPost } = await import("../src/app/api/tts/route");
const { NextRequest } = await import("next/server");
const base = { message: "What did we discuss yesterday?", channel: "web" as const, conversationId: "conversation" };
const nim = { provider: "nvidia-nim", model: "z-ai/glm-5.3-flash" };
const modelCalls = () => calls.filter((c) => /generateContent|streamGenerateContent|chat\/completions/.test(c.url.pathname));
const writes = () => calls.filter((c) => c.url.hostname === "free-fixture.supabase.co" && c.method === "POST");
const worker = { objective: "fixture", contextBlock: "fixture", toolCtx: { freeOnly: true } };
const audio = { name: "voice.wav", mimeType: "audio/wav", size: 3, base64: "AAAA" };
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
    calls.length = 0; unexpected.length = 0; prefs = { freeOnly: true }; profileError = false; allowPaid = false; generationError = false; historyLength = 0; nextTool = ""; truncated = false; flipPolicyOnReply = false; controller = undefined; abortAt = "";
    await run(); await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unexpected, [], "No hidden paid helper or external transport"); passed++; console.log(`PASS ${name}`);
}
await check("public eligibility excludes paid Gemini without relying on metered", async () => {
    const p = listProvidersPublic(); assert(p.find((p) => p.id === "gemini")!.chatModels.every((m) => m.free === false));
    assert(p.find((p) => p.id === "gemini-free")!.chatModels.every((m) => m.free === true)); assert.equal(p.find((p) => p.id === "opencode-zen")!.available, false);
    assert(p.flatMap((p) => [...p.chatModels, ...p.embeddingModels]).every((m) => typeof m.free === "boolean"));
});
await check("persisted true blocks explicit paid selection and false override before writes", async () => {
    await assert.rejects(ragChat({ ...base, provider: "gemini", freeOnly: false }), /Free only/); assert.equal(writes().length, 0);
});
await check("request true tightens disabled preference", async () => {
    prefs = { freeOnly: false }; await assert.rejects(ragChat({ ...base, provider: "gemini", freeOnly: true }), /Free only/); assert.equal(writes().length, 0);
});
await check("unreadable preferences fail closed", async () => {
    profileError = true; await assert.rejects(ragChat(base), /preferences are unavailable/); assert.equal(modelCalls().length, 0);
});
await check("default, summary, classifier, title and deferred extraction avoid paid calls", async () => {
    historyLength = 12; const r = await ragChat(base); assert.equal(r.reply, "Fixture answer"); assert.equal(r.freeOnly, true);
    assert.equal(modelCalls().length, 2); assert.equal(modelCalls()[0].key, "fixture-free"); assert(calls.some((c) => c.method === "PATCH" && c.body.title));
});
await check("stored paid bot selection uses free route", async () => {
    prefs = { freeOnly: true, channelModels: { telegram: "gemini::gemini-3.8-flash" } }; await ragChat({ ...base, channel: "telegram" }); assert.equal(modelCalls()[0].key, "fixture-free");
});
await check("compatible route and helpers stay free", async () => { await ragChat({ ...base, ...nim }); assert.equal(modelCalls().length, 1); assert.equal(modelCalls()[0].key, "Bearer fixture-nim"); });
await check("turn freezes policy for deferred extraction, title and bot voice delivery", async () => {
    flipPolicyOnReply = true; const result = await ragChat(base); assert.equal(prefs.freeOnly, false);
    assert.equal(result.freeOnly, true); assert.equal(modelCalls().length, 1);
});
for (const message of ["/model gemini gemini-3.8-flash", "/embed-model gemini gemini-embedding-2"]) await check("bot refuses " + message, async () => {
    await assert.rejects(ragChat({ message, channel: "telegram" }), /Free only/); assert.equal(writes().length, 0); assert(!calls.some((c) => c.method === "PATCH"));
});
await check("bot model listing captures free policy", async () => { assert.equal((await ragChat({ message: "/model", channel: "telegram" })).freeOnly, true); });
await check("agent lead on compatible selection uses free Gemini key", async () => { await ragChat({ ...base, ...nim, agent: true }); assert.equal(modelCalls()[0].key, "fixture-free"); });
await check("audio fallback uses free Gemini", async () => { await ragChat({ ...base, ...nim, file: audio }); assert.equal(modelCalls()[0].key, "fixture-free"); });
await check("missing free Gemini refuses audio and agent capabilities", async () => {
    process.env.GEMINI_FREE_API_KEY = "";
    try {
        await assert.rejects(ragChat({ ...base, ...nim, file: audio }), /Free only/); assert.equal(writes().length, 0);
        await assert.rejects(ragChat({ ...base, ...nim, agent: true }), /Free only/); assert.equal(modelCalls().length, 0);
    } finally { process.env.GEMINI_FREE_API_KEY = "fixture-free"; }
});
await check("missing all free keys rejects before writes", async () => {
    process.env.GEMINI_FREE_API_KEY = ""; process.env.NVIDIA_NIM_API_KEY = "";
    try { await assert.rejects(ragChat(base), /Free only/); assert.equal(writes().length, 0); }
    finally { process.env.GEMINI_FREE_API_KEY = "fixture-free"; process.env.NVIDIA_NIM_API_KEY = "fixture-nim"; }
});
await check("missing free embedding key refuses without switching partitions", async () => {
    process.env.NVIDIA_NIM_API_KEY = "";
    try { await assert.rejects(ragChat(base), /Free only/); assert.equal(writes().length, 0); assert.equal(modelCalls().length, 0); }
    finally { process.env.NVIDIA_NIM_API_KEY = "fixture-nim"; }
});
await check("paid active partition refuses chat and knowledge-only without migration", async () => {
    await setEmbeddingOverride("gemini-embedding-2"); calls.length = 0;
    try {
        for (const knowledgeOnly of [false, true]) await assert.rejects(ragChat({ ...base, knowledgeOnly }), /Free only/);
        assert.equal(writes().length, 0); assert(!calls.some((c) => /embedContent|\/embeddings$/.test(c.url.pathname)));
    } finally { await setEmbeddingOverride("nvidia/nemotron-3-embed-1b"); }
});
await check("knowledge-only uses free partition without generation", async () => { assert.match((await ragChat({ ...base, knowledgeOnly: true })).reply, /could not find/); assert.equal(modelCalls().length, 0); });
await check("worker ignores paid model hint", async () => { await runWorker({ ...worker, embRef: getEmbeddingRef(), modelHint: "gemini-3.8-flash" }); assert.equal(modelCalls()[0].key, "Bearer fixture-nim"); });
await check("worker exhaustion has no paid fallback", async () => {
    generationError = true; await assert.rejects(runWorker({ ...worker, embRef: getEmbeddingRef() }), /No paid fallback/); assert(modelCalls().some((c) => c.key === "fixture-free"));
});
for (const tool of ["search_web", "create_artifact", "vault_ingest", "vault_write", "vault_lint", "vault_search", "manage_notes", "manage_memory_facts", "council_convene", "council_propose"]) await check("tool refuses before side effects: " + tool, async () => {
    assert.match(await executeTool(tool, { content: "fixture", query: "fixture", action: "correct" }, getEmbeddingRef(), { freeOnly: true }), /Free only/); assert.equal(calls.length, 0);
});
await check("real Gemini search uses native grounding on the same free credential", async () => {
    nextTool = "search_web"; await ragChat(base);
    assert.equal(modelCalls().length, 3);
    assert(modelCalls().every((call) => call.key === "fixture-free"));
    assert.match(JSON.stringify(modelCalls()[1].body.contents), /fixture/);
    assert.match(JSON.stringify(modelCalls()[1].body.tools), /googleSearch/);
});
await check("continuation keeps free credential", async () => { truncated = true; await ragChat(base); assert.equal(modelCalls().length, 2); });
for (const stage of ["before", "embedding", "generation"]) await check("cancel has no fallback: " + stage, async () => {
    controller = new AbortController(); abortAt = stage; if (stage === "before") controller.abort();
    await assert.rejects(ragChat({ ...base, ...nim, signal: controller.signal }), { name: "AbortError" }); assert.equal(modelCalls().length, stage === "generation" ? 1 : 0);
});
await check("TTS rejects saved policy and request tightening", async () => {
    for (const stream of [false, true]) assert.equal((await ttsPost(new NextRequest("https://fixture.invalid/api/tts", { method: "POST", body: JSON.stringify({ text: "fixture", stream }) }))).status, 409);
    prefs = { freeOnly: false }; assert.equal((await ttsPost(new NextRequest("https://fixture.invalid/api/tts", { method: "POST", body: JSON.stringify({ text: "fixture", freeOnly: true }) }))).status, 409); assert.equal(modelCalls().length, 0);
});
for (const post of [chatPost, streamPost]) {
    await check("HTTP forwards request tightening against saved false", async () => {
        prefs = { freeOnly: false };
        const r = await post(new NextRequest("https://fixture.invalid/api/chat", { method: "POST", headers: { authorization: "Bearer fixture-chat" }, body: JSON.stringify({ ...base, provider: "gemini", freeOnly: true }) }));
        assert.match(await r.text(), /Free only/); assert.equal(modelCalls().length, 0);
    });
    await check("HTTP rejects false opt-out and ignores client paidOnly", async () => {
        const r = await post(new NextRequest("https://fixture.invalid/api/chat", { method: "POST", headers: { authorization: "Bearer fixture-chat" }, body: JSON.stringify({ ...base, provider: "gemini", freeOnly: false, paidOnly: true }) })); assert.match(await r.text(), /Free only/); assert.equal(modelCalls().length, 0);
    });
    await check("HTTP validates freeOnly", async () => {
        const r = await post(new NextRequest("https://fixture.invalid/api/chat", { method: "POST", headers: { authorization: "Bearer fixture-chat" }, body: JSON.stringify({ ...base, freeOnly: "false" }) })); assert.equal(r.status, 400); assert.equal(calls.length, 0);
    });
}
await check("normal mode retains paid selection and helpers", async () => { prefs = { freeOnly: false }; allowPaid = true; await ragChat({ ...base, channel: "telegram", provider: "gemini" }); assert(modelCalls().some((c) => c.key === "fixture-paid")); });
await check("server scheduled override keeps lead and worker paid", async () => {
    allowPaid = true; await ragChat({ ...base, message: "hi", channel: "telegram", ...nim, paidOnly: true, freeOnly: true }); assert.equal(modelCalls()[0].key, "fixture-paid"); calls.length = 0;
    await runWorker({ ...worker, embRef: getEmbeddingRef(), paidOnly: true, freeOnly: true }); assert.equal(modelCalls().length, 1); assert.equal(modelCalls()[0].key, "fixture-paid");
});
console.log(`${passed} Free only production-path fixture checks passed.`);
