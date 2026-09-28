import assert from "node:assert/strict";
import { collectModelObservations, observeGeminiClient, withModelObservationCollector, beginExternalServiceObservation } from "../src/lib/ai/model-observations";
import type { GoogleGenAI } from "@google/genai";

const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14, cachedContentTokenCount: 2 };
const fakeClient = (models: Record<string, unknown>) => ({ models }) as unknown as GoogleGenAI;
let checks = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); checks++; }

await check("parallel scopes isolate calls and retain no prompt or error text", async () => {
    const client = observeGeminiClient(fakeClient({ generateContent: async () => ({ text: "secret reply", usageMetadata }) }), { providerId: "gemini", purpose: "chat" });
    const results = await Promise.all(["a", "b"].map((model) => collectModelObservations(async () => {
        await client.models.generateContent({ model, contents: "secret prompt" });
        return model;
    })));
    for (const result of results) {
        assert.equal(result.observations.length, 1);
        assert.equal(result.observations[0].modelId, result.value);
        assert.equal(result.observations[0].status, "success");
        assert.equal(result.observations[0].usage.totalTokens, 14);
        assert.ok(!JSON.stringify(result.observations).includes("secret"));
    }
});

await check("stream cumulative usage counted once and first answer excludes thoughts", async () => {
    const original = fakeClient({ generateContentStream: async function* () {
        yield { candidates: [{ content: { parts: [{ text: "private reasoning", thought: true }] } }] };
        yield { candidates: [{ content: { parts: [{ text: "answer" }] } }], usageMetadata };
        yield { usageMetadata, candidates: [{ finishReason: "STOP" }] };
    } });
    const client = observeGeminiClient(original, { providerId: "gemini-paid", purpose: "chat" });
    const result = await collectModelObservations(async () => {
        for await (const chunk of await client.models.generateContentStream({ model: "fixture", contents: "private" })) void chunk;
    });
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].usage.totalTokens, 14);
    assert.notEqual(result.observations[0].firstAnswerMs, null);
    assert.equal(result.observations[0].capabilities.streaming, true);
    assert.notEqual(client.models, original.models);
});

await check("failed and interrupted streams discard unfinalised token counts", async () => {
    for (const status of [401, 429, 404, 410, 503]) {
        const client = observeGeminiClient(fakeClient({ generateContent: async () => { throw Object.assign(new Error("secret error body"), { status }); } }), { providerId: "gemini", purpose: "chat" });
        const observations: import("../src/lib/ai/model-observations").ModelCallObservation[] = [];
        await assert.rejects(withModelObservationCollector(observations, () => client.models.generateContent({ model: "fixture", contents: "private" })));
        assert.equal(observations.length, 1);
        assert.equal(observations[0].status, ({ 401: "auth", 429: "rate_limit", 404: "unavailable", 410: "retired", 503: "transient" })[status]);
        assert.ok(!JSON.stringify(observations).includes("secret"));
    }
    const client = observeGeminiClient(fakeClient({ generateContentStream: async function* () { yield { usageMetadata }; throw new Error("private failure"); } }), { providerId: "gemini", purpose: "chat" });
    const observations: import("../src/lib/ai/model-observations").ModelCallObservation[] = [];
    await assert.rejects(withModelObservationCollector(observations, async () => { for await (const chunk of await client.models.generateContentStream({ model: "fixture", contents: "private" })) void chunk; }));
    assert.equal(observations[0].usage.totalTokens, null);
    assert.equal(observations[0].status, "unknown");
});

await check("stream consumer cancellation records aborted once", async () => {
    const client = observeGeminiClient(fakeClient({ generateContentStream: async function* () { yield { usageMetadata }; yield { usageMetadata }; } }), { providerId: "gemini", purpose: "chat" });
    const { observations } = await collectModelObservations(async () => {
        for await (const chunk of await client.models.generateContentStream({ model: "fixture", contents: "private" })) { void chunk; break; }
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, "aborted");
    assert.equal(observations[0].usage.totalTokens, null);
});
await check("reusing a wrapped client cannot double-count a request", async () => {
    const raw = fakeClient({ generateContent: async () => ({ usageMetadata }) });
    const first = observeGeminiClient(raw, { providerId: "gemini", purpose: "chat" });
    const second = observeGeminiClient(first, { providerId: "gemini", purpose: "summary" });
    const { observations } = await collectModelObservations(() => second.models.generateContent({ model: "fixture", contents: "private" }));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].purpose, "summary");
});
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture", GEMINI_API_KEY: "fixture", KILO_API_KEY: "fixture", NVIDIA_NIM_API_KEY: "fixture", TAVILY_API_KEY: "fixture" });
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
try {
    const { openaiCompatChat } = await import("../src/lib/ai/openai-compat");
    const { getProvider, resolveEmbedding } = await import("../src/lib/ai/providers");
    const provider = getProvider("kilo")!;
    const base = { provider, model: provider.chatModels[0], systemText: "private system", userText: "private user", embRef: resolveEmbedding(), allowTools: new Set<string>() };
    const stream = (frames: unknown[]) => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    const stop = { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } };
    console.warn = () => {};
    await check("compat failure and retry each recorded exactly once", async () => {
        const responses = [new Response("private body", { status: 429 }), stream([stop])];
        globalThis.fetch = async () => responses.shift()!;
        const { observations } = await collectModelObservations(() => openaiCompatChat(base));
        assert.equal(observations.length, 2);
        assert.equal(observations[0].status, "rate_limit");
        assert.equal(observations[0].usage.totalTokens, null);
        assert.equal(observations[1].status, "success");
        assert.equal(observations[1].usage.totalTokens, 10);
        assert.notEqual(observations[1].firstAnswerMs, null);
        assert.ok(!JSON.stringify(observations).includes("private"));
    });
    await check("compat actual tool-call response verifies tools and continuation remains separate", async () => {
        const responses = [stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "tool", function: { name: "denied", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }]), stream([{ choices: [{ delta: { content: "Partial " }, finish_reason: "length" }] }]), stream([stop])];
        globalThis.fetch = async () => responses.shift()!;
        const { observations } = await collectModelObservations(() => openaiCompatChat(base));
        assert.equal(observations.length, 3);
        assert.equal(observations[0].capabilities.tools, true);
        assert.equal(observations[1].capabilities.tools, false);
        assert.equal(observations[2].purpose, "continuation");
    });
    await check("compat cancellation retains one aborted observation", async () => {
        const controller = new AbortController();
        globalThis.fetch = async () => { controller.abort(); throw new DOMException("private cancel", "AbortError"); };
        const observations: import("../src/lib/ai/model-observations").ModelCallObservation[] = [];
        await assert.rejects(withModelObservationCollector(observations, () => openaiCompatChat({ ...base, signal: controller.signal })));
        assert.equal(observations.length, 1);
        assert.equal(observations[0].status, "aborted");
    });
    await check("compat reasoning blocks do not become first-answer evidence", async () => {
        const responses = [stream([{ choices: [{ delta: { content: "<think>private reasoning</think>" }, finish_reason: "stop" }] }]), stream([stop])];
        globalThis.fetch = async () => responses.shift()!;
        const { observations } = await collectModelObservations(() => openaiCompatChat(base));
        assert.equal(observations[0].firstAnswerMs, null);
        assert.notEqual(observations[1].firstAnswerMs, null);
    });
    await check("empty stream cannot verify streaming capability", async () => {
        const responses = [new Response(""), stream([stop])];
        globalThis.fetch = async () => responses.shift()!;
        const { observations } = await collectModelObservations(() => openaiCompatChat(base));
        assert.equal(observations[0].capabilities.streaming, false);
        assert.equal(observations[0].status, "unknown");
    });
    await check("Gemini SDK adapter preserves supplied client credentials and config", async () => {
        const { GoogleGenAI } = await import("@google/genai");
        const supplied = new GoogleGenAI({ apiKey: "fixture-request-key" });
        const client = observeGeminiClient(supplied, { providerId: "gemini-personal", purpose: "summary" });
        globalThis.fetch = async (_url, init) => {
            const headers = new Headers(init?.headers);
            assert.equal(headers.get("x-goog-api-key"), "fixture-request-key");
            assert.match(String(init?.body), /fixture-input/);
            return Response.json({ candidates: [{ content: { parts: [{ text: "summary" }] }, finishReason: "STOP" }], usageMetadata });
        };
        const { observations } = await collectModelObservations(() => client.models.generateContent({ model: "gemini-fixture", contents: "fixture-input", config: { temperature: 0.2 } }));
        assert.equal(observations[0].providerId, "gemini-personal");
        assert.equal(observations[0].purpose, "summary");
        assert.equal(observations[0].usage.totalTokens, 14);
    });
    await check("embedding actual adapter retains provider usage without inferring output zero", async () => {
        const { embedText } = await import("../src/lib/ai/embeddings");
        const ref = resolveEmbedding();
        globalThis.fetch = async () => Response.json({ data: [{ embedding: Array(ref.model.dimension).fill(0.1) }], usage: { prompt_tokens: 5, total_tokens: 5 } });
        const { observations } = await collectModelObservations(() => embedText(ref, "private source"));
        assert.equal(observations.length, 1);
        assert.equal(observations[0].purpose, "embedding");
        assert.equal(observations[0].usage.promptTokens, 5);
        assert.equal(observations[0].usage.outputTokens, null);
    });
    await check("agent-loop actual adapter observes every tool turn with explicit identity", async () => {
        const { runGeminiLoop } = await import("../src/lib/ai/agent/gemini-loop");
        const responses = [
            { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "fixture", args: {} } }] }, finishReason: "STOP" }], usageMetadata },
            { candidates: [{ content: { role: "model", parts: [{ text: "Answer" }] }, finishReason: "STOP" }], usageMetadata },
        ];
        globalThis.fetch = async () => Response.json(responses.shift());
        const { observations } = await collectModelObservations(() => runGeminiLoop({ providerId: "gemini-free", purpose: "worker", model: "fixture", apiKey: "fixture-worker", systemPrompt: "private", userMessage: "private", toolDeclarations: [], dispatch: async () => "result", maxRounds: 2 }));
        assert.equal(observations.length, 2);
        assert.ok(observations.every((observation) => observation.providerId === "gemini-free" && observation.purpose === "worker"));
        assert.equal(observations[0].capabilities.tools, true);
    });
    await check("routing and Gemini grounding helper calls are visible inside assistant scope", async () => {
        const { classifyIntent } = await import("../src/lib/ai/agent/router");
        const { geminiWebSearch } = await import("../src/lib/ai/web-search");
        globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: '{"mode":"chat"}' }] }, finishReason: "STOP" }], usageMetadata });
        const routing = await collectModelObservations(() => classifyIntent("Please explain this unfamiliar concept in detail"));
        assert.equal(routing.observations.length, 1);
        assert.equal(routing.observations[0].purpose, "routing");
        globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: "Facts" }] }, finishReason: "STOP", groundingMetadata: { groundingChunks: [{ web: { uri: "https://private.invalid" } }] } }], usageMetadata });
        const search = await collectModelObservations(() => geminiWebSearch("private query"));
        assert.equal(search.observations.length, 1);
        assert.equal(search.observations[0].purpose, "search");
        assert.equal(search.observations[0].capabilities.grounding, true);
        assert.ok(!JSON.stringify(search.observations).includes("private"));
    });
    await check("memory extraction records model call and search embedding separately", async () => {
        const { extractMemories } = await import("../src/lib/ai/memory/extractor");
        globalThis.fetch = async (input) => {
            const url = String(input);
            if (url.includes("/embeddings")) return Response.json({ data: [{ embedding: Array(resolveEmbedding().model.dimension).fill(0.1) }], usage: { prompt_tokens: 2, total_tokens: 2 } });
            if (url.includes("generativelanguage")) return Response.json({ candidates: [{ content: { parts: [{ text: '{"operations":[]}' }] }, finishReason: "STOP" }], usageMetadata });
            if (url.includes("fixture.invalid")) return Response.json([]);
            throw new Error("Unexpected offline fixture recipient");
        };
        const { observations } = await collectModelObservations(() => extractMemories({ userMessage: "I prefer offline software for personal projects.", assistantReply: "Understood", channel: "web" }));
        assert.equal(observations.filter((observation) => observation.purpose === "extraction").length, 1);
        assert.equal(observations.filter((observation) => observation.purpose === "embedding").length, 1);
    });
    await check("external search service trail remains distinct from model tokens", async () => {
        const result = await collectModelObservations(async () => {
            const observation = beginExternalServiceObservation({ providerId: "tavily", operation: "web_search" });
            observation.finish({ error: Object.assign(new Error("private query body"), { status: 429 }) });
            observation.finish();
        });
        assert.equal(result.observations.length, 0);
        assert.equal(result.externalServices.length, 1);
        assert.equal(result.externalServices[0].status, "rate_limit");
        assert.ok(!("modelId" in result.externalServices[0]));
        assert.ok(!("usage" in result.externalServices[0]));
        assert.ok(!JSON.stringify(result.externalServices).includes("private"));
    });
    await check("Tavily actual adapter records recipient without query or results", async () => {
        const { webSearch } = await import("../src/lib/ai/web-search");
        globalThis.fetch = async (input) => {
            assert.equal(String(input), "https://api.tavily.com/search");
            return Response.json({ answer: "private answer", results: [{ title: "private title", url: "https://private.invalid", content: "private result" }] });
        };
        const { observations, externalServices } = await collectModelObservations(() => webSearch("private query"));
        assert.equal(observations.length, 0);
        assert.equal(externalServices.length, 1);
        assert.equal(externalServices[0].providerId, "tavily");
        assert.equal(externalServices[0].operation, "web_search");
        assert.equal(externalServices[0].status, "success");
        assert.ok(!JSON.stringify(externalServices).includes("private"));
    });
} finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
console.log(`${checks} model observation checks passed using offline adapters.`);
