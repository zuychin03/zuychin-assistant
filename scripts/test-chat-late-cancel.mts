import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://late-cancel.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture",
    GEMINI_API_KEY: "fixture", NVIDIA_NIM_API_KEY: "fixture", KNOWLEDGE_EMBEDDING_MODEL: "",
});
const originalFetch = globalThis.fetch;
let abortAt = "";
let controller = new AbortController();
let saved: string[] = [];
let deleted: string[] = [];
let extractionCalls = 0;
const userId = "10000000-0000-4000-8000-000000000001";
const assistantId = "10000000-0000-4000-8000-000000000002";
const conversationId = "10000000-0000-4000-8000-000000000003";
globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.hostname === "late-cancel.invalid") {
        const table = url.pathname.replace("/rest/v1/", "");
        if (table === "user_profiles") return Response.json({ id: "10000000-0000-4000-8000-000000000004", preferences: {}, system_prompt: "Fixture" });
        if (table === "cron_state") return Response.json({ value: { model: "nvidia/nemotron-3-embed-1b" } });
        if (table === "messages" && method === "POST") {
            const id = body.role === "user" ? userId : assistantId;
            saved.push(id);
            if (body.role === "assistant" && abortAt === "assistant") controller.abort();
            return Response.json({ id });
        }
        if (table === "messages" && method === "DELETE") { deleted.push(url.searchParams.get("id")!.slice(3)); return Response.json([]); }
        if (table === "messages" && url.searchParams.get("select") === "metadata,user_profile_id") {
            if (abortAt === "trace-read") controller.abort();
            return Response.json({ metadata: {}, user_profile_id: null });
        }
        if (table === "rpc/assistant_reply_trace_save") { if (abortAt === "trace-save") controller.abort(); return Response.json(true); }
        if (table === "rpc/assistant_context_snapshot") return Response.json({ code: "PGRST202", message: "Fixture missing migration" }, { status: 404 });
        if (table === "conversations") return Response.json({ id: conversationId, title: "New Chat", project_id: null, projects: null });
        if (method === "HEAD") return new Response(null, { headers: { "Content-Range": "*/1" } });
        if (["messages", "model_call_observations", "knowledge_links", "memories", "embeddings", "rpc/match_embeddings", "rpc/match_memories", "rpc/hybrid_recall_knowledge_chunks", "todos"].includes(table)) return Response.json([]);
    }
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname.endsWith("/embeddings")) return Response.json({ data: [{ embedding: Array(2048).fill(0.1) }] });
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname.endsWith("/chat/completions")) return new Response('data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    if (url.hostname === "generativelanguage.googleapis.com") {
        const extraction = body.generationConfig?.responseMimeType === "application/json";
        if (extraction) extractionCalls++;
        else if (abortAt === "title") controller.abort();
        return Response.json({ candidates: [{ content: { parts: [{ text: extraction ? '{"operations":[]}' : "Fixture title" }] }, finishReason: "STOP" }] });
    }
    throw new Error(`Unexpected offline fixture recipient ${url.hostname}${url.pathname}`);
};

try {
    const { ragChat } = await import("../src/lib/ai/rag-service");
    let checks = 0;
    for (const knowledgeOnly of [false, true]) for (const phase of ["assistant", "trace-read", "trace-save", ...(!knowledgeOnly ? ["title"] : [])]) {
        abortAt = phase; controller = new AbortController(); saved = []; deleted = []; extractionCalls = 0;
        await assert.rejects(ragChat({ message: "hello", channel: "web", conversationId, provider: "nvidia-nim", model: "z-ai/glm-5.3-flash", knowledgeOnly, signal: controller.signal }), { name: "AbortError" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual([...new Set(deleted)].sort(), [userId, assistantId].sort());
        assert.deepEqual(saved.sort(), [userId, assistantId].sort());
        assert.equal(extractionCalls, 0);
        console.log(`PASS ${knowledgeOnly ? "knowledge" : "normal"} cancellation at ${phase} removes only this turn and starts no extraction`);
        checks++;
    }
    console.log(`${checks} late cancellation checks passed.`);
} finally { globalThis.fetch = originalFetch; }
