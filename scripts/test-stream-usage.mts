import assert from "node:assert/strict";

const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://usage-fixture.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-gemini",
    KILO_API_KEY: "fixture-kilo",
};
const savedEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalError = console.error;
Object.assign(process.env, env);
globalThis.fetch = async () => { throw new Error("Unexpected network call"); };

type Usage = { promptTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null; completeness: "complete" | "partial" | "unavailable" };
const usage = (prompt = 10, output = 4, cached = 2) => ({ prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: cached } });
const text = (content = "Xin chào 🌌") => ({ choices: [{ delta: { content } }] });
const stop = { choices: [{ delta: {}, finish_reason: "stop" }] };
const tool = { choices: [{ delta: { tool_calls: [{ index: 0, id: "fixture-tool", function: { name: "fixture_denied", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
function stream(frames: unknown[], failure?: Error, done = true): Response {
    const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") + (done ? "data: [DONE]\n\n" : ""));
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset < bytes.length) {
                controller.enqueue(bytes.slice(offset, offset + 1));
                offset++;
            } else if (failure) controller.error(failure);
            else controller.close();
        },
    }));
}
let checks = 0;
try {
    const { openaiCompatChat } = await import("../src/lib/ai/openai-compat");
    const { getProvider, resolveEmbedding } = await import("../src/lib/ai/providers");
    const provider = getProvider("kilo")!;
    const base = { provider, model: provider.chatModels[0], systemText: "Fixture", userText: "Fixture", embRef: resolveEmbedding(), allowTools: new Set<string>() };
    async function run(responses: Response[], extra: Partial<Parameters<typeof openaiCompatChat>[0]> = {}) {
        let measured: unknown;
        let callbacks = 0;
        const bodies: Record<string, unknown>[] = [];
        const tokens: string[] = [];
        globalThis.fetch = async (input, init) => {
            assert.equal(String(input), `${provider.baseUrl}/chat/completions`);
            bodies.push(JSON.parse(String(init?.body)));
            assert.ok(responses.length, "Unexpected extra request");
            return responses.shift()!;
        };
        const reply = await openaiCompatChat({ ...base, onUsage: (value) => { measured = value; callbacks++; }, onToken: (token) => tokens.push(token), ...extra });
        assert.equal(responses.length, 0);
        assert.equal(callbacks, 1);
        assert.ok(bodies.every((body) => !("stream_options" in body)), "Kilo must not receive undocumented stream options");
        return { reply, measured: measured as Usage, tokens, bodies };
    }
    async function check(name: string, fn: () => Promise<void>) { await fn(); checks++; console.log(`PASS ${name}`); }
    await check("usage-only terminal frame survives fragmented UTF-8", async () => {
        const result = await run([stream([text(), stop, { choices: [], usage: usage() }])]);
        assert.equal(result.reply, "Xin chào 🌌");
        assert.equal(result.tokens.join(""), "Xin chào 🌌");
        assert.deepEqual(result.measured, { promptTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2, completeness: "complete" });
    });
    await check("latest cumulative snapshot replaces duplicate and earlier counts", async () => {
        const result = await run([stream([{ ...text(), usage: usage(10, 1) }, { usage: usage() }, { usage: usage() }, stop])]);
        assert.equal(result.measured.totalTokens, 14);
    });
    await check("independent tool requests are summed once", async () => {
        const result = await run([stream([tool, { usage: usage() }]), stream([tool, { usage: usage(20, 5, 3) }]), stream([text(), stop, { usage: usage(30, 6, 4) }])]);
        assert.deepEqual(result.measured, { promptTokens: 60, outputTokens: 15, totalTokens: 75, cachedInputTokens: 9, completeness: "complete" });
        assert.equal(result.bodies.length, 3);
    });
    await check("explicit zero is measured", async () => {
        const result = await run([stream([text(), stop, { usage: usage(0, 0, 0) }])]);
        assert.deepEqual(result.measured, { promptTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, completeness: "complete" });
    });
    await check("absent usage and nullable usage remain unavailable", async () => {
        const result = await run([stream([text(), { usage: null }, stop])]);
        assert.deepEqual(result.measured, { promptTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, completeness: "unavailable" });
    });
    await check("invalid counts are never coerced or inferred", async () => {
        for (const invalid of [-1, 1.5, "10", null, Number.MAX_SAFE_INTEGER + 1]) {
            const result = await run([stream([text(), stop, { usage: { prompt_tokens: invalid, completion_tokens: 4, total_tokens: invalid, prompt_tokens_details: { cached_tokens: invalid } } }])]);
            assert.deepEqual(result.measured, { promptTokens: null, outputTokens: 4, totalTokens: null, cachedInputTokens: null, completeness: "partial" });
        }
    });
    await check("missing cache detail is unknown without inventing a cache saving", async () => {
        const result = await run([stream([text(), stop, { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }])]);
        assert.equal(result.measured.cachedInputTokens, null);
        assert.equal(result.measured.completeness, "complete");
    });
    await check("DeepSeek direct cache count is accepted only when nested detail is absent", async () => {
        for (const [detail, expected] of [[undefined, 3], [{ cached_tokens: 2 }, 2], [{ cached_tokens: -1 }, null], [{ cached_tokens: null }, null]] as const) {
            const result = await run([stream([text(), { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 3, prompt_tokens_details: detail } }])]);
            assert.equal(result.measured.cachedInputTokens, expected);
        }
    });
    await check("malformed usage values remain wholly unavailable", async () => {
        for (const raw of ["bad", 7, [], {}, { prompt_tokens: -1, completion_tokens: "3", total_tokens: null }]) {
            const result = await run([stream([text(), stop, { usage: raw }])]);
            assert.deepEqual(result.measured, { promptTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, completeness: "unavailable" });
        }
    });
    await check("length completion and continuation each retain their measured usage", async () => {
        const result = await run([stream([text("Partial "), { choices: [{ finish_reason: "length" }], usage: usage() }]), stream([text("answer."), stop, { usage: usage(20, 5, 3) }])]);
        assert.equal(result.reply, "Partial answer.");
        assert.deepEqual(result.measured, { promptTokens: 30, outputTokens: 9, totalTokens: 39, cachedInputTokens: 5, completeness: "complete" });
    });
    await check("a missing request measurement makes the aggregate unknown", async () => {
        const result = await run([stream([tool]), stream([text(), stop, { usage: usage() }])]);
        assert.deepEqual(result.measured, { promptTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, completeness: "partial" });
    });
    console.warn = () => {};
    console.error = () => {};
    await check("interrupted output recovers but incomplete usage remains unknown", async () => {
        const result = await run([stream([text("Partial ")], new Error("fixture interruption"), false), stream([text("answer."), stop, { usage: usage() }])]);
        assert.equal(result.reply, "Partial answer.");
        assert.equal(result.measured.totalTokens, null);
        assert.equal(result.measured.completeness, "partial");
    });
    await check("failed request plus compatibility retry cannot look fully measured", async () => {
        const result = await run([new Response("fixture unsupported mode", { status: 400 }), stream([text(), stop, { usage: usage() }])]);
        assert.equal(result.measured.totalTokens, null);
        assert.equal(result.measured.completeness, "partial");
    });
    await check("an interrupted cumulative snapshot is not treated as final usage", async () => {
        const result = await run([stream([text("Partial "), { usage: usage() }], new Error("fixture interruption"), false), stream([text("answer."), stop, { usage: usage() }])]);
        assert.equal(result.reply, "Partial answer.");
        assert.equal(result.measured.totalTokens, null);
        assert.equal(result.measured.completeness, "partial");
    });
    await check("silent EOF without a terminal frame leaves usage incomplete", async () => {
        const result = await run([stream([text(), { usage: usage() }], undefined, false)]);
        assert.equal(result.measured.totalTokens, null);
        assert.equal(result.measured.completeness, "partial");
    });
    await check("caller cancellation never retries a provider request", async () => {
        const controller = new AbortController();
        let requests = 0;
        let measured: unknown;
        globalThis.fetch = async () => {
            requests++;
            controller.abort();
            throw new DOMException("Fixture cancellation", "AbortError");
        };
        await assert.rejects(openaiCompatChat({ ...base, signal: controller.signal, onUsage: (value) => { measured = value; } }), { name: "AbortError" });
        assert.equal(requests, 1);
        assert.deepEqual(measured, { promptTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, completeness: "unavailable" });
    });
    await check("worker unknown usage stays unknown", async () => {
        const { runWorker } = await import("../src/lib/ai/agent/worker");
        globalThis.fetch = async (input) => {
            assert.equal(String(input), `${provider.baseUrl}/chat/completions`);
            return stream([text(), stop]);
        };
        const result = await runWorker({ objective: "Fixture", modelHint: base.model.name, needsTools: false, contextBlock: "", embRef: base.embRef, toolCtx: {} });
        assert.equal(result.tokens, null);
    });
    await check("worker fallback retains an earlier unknown attempt", async () => {
        const { runWorker } = await import("../src/lib/ai/agent/worker");
        let requests = 0;
        globalThis.fetch = async (input) => {
            assert.equal(String(input), `${provider.baseUrl}/chat/completions`);
            requests++;
            return requests <= 2 ? stream([stop]) : stream([text(), stop, { usage: usage() }]);
        };
        const result = await runWorker({ objective: "Fixture", modelHint: base.model.name, needsTools: false, contextBlock: "", embRef: base.embRef, toolCtx: {} });
        assert.equal(requests, 3);
        assert.equal(result.tokens, null);
    });
    console.log(`${checks} streamed usage checks passed; all transport calls used offline fixtures.`);
} finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
