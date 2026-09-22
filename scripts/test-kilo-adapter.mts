import assert from "node:assert/strict";

const fixtureEnv: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: "https://adapter-fixture.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "adapter-fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "adapter-fixture-service",
    GEMINI_API_KEY: "adapter-fixture-gemini",
    KILO_API_KEY: "adapter-fixture-kilo",
    OPENCODE_ZEN_API_KEY: "adapter-fixture-zen",
};
const previousEnv = new Map(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let checks = 0;

type RequestBody = {
    model: string;
    stream: boolean;
    reasoning?: { enabled: boolean; effort?: string };
    max_tokens?: number;
    tools?: { function: { name: string } }[];
    tool_choice?: string | { type: string; function: { name: string } };
    messages: { role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }[];
};

function streamResponse(deltas: unknown[], finishReason = "stop"): Response {
    const frames: unknown[] = deltas.map((delta) => ({ choices: [{ delta }] }));
    frames.push({ choices: [{ delta: {}, finish_reason: finishReason }] });
    const bytes = new TextEncoder().encode(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") + "data: [DONE]\n\n",
    );
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
            controller.close();
        },
    }), { headers: { "Content-Type": "text/event-stream" } });
}

function intercept(responses: Response[]): RequestBody[] {
    const bodies: RequestBody[] = [];
    globalThis.fetch = async (input, init) => {
        assert.equal(String(input), "https://api.kilo.ai/api/gateway/chat/completions");
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer adapter-fixture-kilo");
        assert.equal(typeof init?.body, "string");
        bodies.push(JSON.parse(init?.body as string) as RequestBody);
        const response = responses.shift();
        assert.ok(response, "Unexpected extra request; no network access is permitted.");
        return response;
    };
    return bodies;
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

try {
    Object.assign(process.env, fixtureEnv);
    globalThis.fetch = async () => { throw new Error("Unexpected fetch; this suite is offline."); };
    const { openaiCompatChat } = await import("../src/lib/ai/openai-compat");
    const { getProvider, resolveEmbedding } = await import("../src/lib/ai/providers");
    const provider = getProvider("kilo")!;
    assert.ok(provider);
    const model = provider.chatModels[0];
    const base = {
        provider,
        model,
        systemText: "Local adapter fixture.",
        userText: "Return a short fixture reply.",
        embRef: resolveEmbedding("nvidia/nemotron-3-embed-1b"),
        allowTools: new Set(["search_web"]),
    };

    await check("Kilo thinking uses enabled and high effort with tool declarations", async () => {
        const bodies = intercept([streamResponse([{ content: "Fixture reply." }])]);
        assert.equal(await openaiCompatChat({ ...base, thinking: true }), "Fixture reply.");
        assert.equal(bodies.length, 1);
        assert.deepEqual(bodies[0].reasoning, { enabled: true, effort: "high" });
        assert.equal(bodies[0].model, model.id);
        assert.equal(bodies[0].stream, true);
        assert.deepEqual(bodies[0].tools?.map((tool) => tool.function.name), ["search_web"]);
    });

    await check("Kilo thinking off is explicit and omits effort", async () => {
        const bodies = intercept([streamResponse([{ content: "Fixture reply." }])]);
        await openaiCompatChat({ ...base, thinking: false });
        assert.deepEqual(bodies[0].reasoning, { enabled: false });
    });

    await check("Lightning retains ordinary tools without forcing unsupported search", async () => {
        const lightning = provider.chatModels.find((entry) => entry.id === "nvidia/nemotron-3.5-lightning:free")!;
        const bodies = intercept([streamResponse([{ content: "Fixture reply." }])]);
        await openaiCompatChat({ ...base, model: lightning, search: true });
        assert.equal(bodies[0].tool_choice, "auto");
        assert.deepEqual(bodies[0].tools?.map((tool) => tool.function.name), ["search_web"]);
    });

    await check("Fragmented SSE preserves UTF-8 answer text without exposing reasoning", async () => {
        const bodies = intercept([streamResponse([
            { reasoning_content: "Internal fixture reasoning." },
            { content: "Xin chào " },
            { content: "🌌" },
            { content: "." },
        ])]);
        const tokens: { text: string; reset?: boolean }[] = [];
        const reply = await openaiCompatChat({ ...base, thinking: true, onToken: (text, reset) => tokens.push({ text, reset }) });
        assert.equal(reply, "Xin chào 🌌.");
        assert.deepEqual(tokens, [{ text: "Xin chào ", reset: true }, { text: "🌌", reset: false }, { text: ".", reset: false }]);
        assert.equal(bodies.length, 1);
    });

    await check("Kilo request caps match every registered model", async () => {
        for (const selectedModel of provider.chatModels) {
            const bodies = intercept([streamResponse([{ content: "Fixture reply." }])]);
            await openaiCompatChat({ ...base, model: selectedModel, genParams: { maxTokens: 1_000_000 } });
            assert.equal(bodies[0].max_tokens, selectedModel.maxOutputTokens);
        }
    });

    await check("Rejected tool/reasoning request retries with both disabled", async () => {
        const bodies = intercept([new Response("Fixture unsupported mode", { status: 400 }), streamResponse([{ content: "Recovered reply." }])]);
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            assert.equal(await openaiCompatChat({ ...base, thinking: true }), "Recovered reply.");
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(bodies.length, 2);
        assert.deepEqual(bodies[0].reasoning, { enabled: true, effort: "high" });
        assert.deepEqual(bodies[1].reasoning, { enabled: false });
        assert.equal(bodies[1].tools, undefined);
    });

    await check("Streamed tool fragments assemble without executing disallowed tools", async () => {
        const bodies = intercept([
            streamResponse([
                { tool_calls: [{ index: 0, id: "fixture-call", function: { name: "fixture_unavailable", arguments: '{"query":' } }] },
                { tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] },
            ], "tool_calls"),
            streamResponse([{ content: "Tool refusal handled." }]),
        ]);
        assert.equal(await openaiCompatChat({ ...base, allowTools: new Set<string>() }), "Tool refusal handled.");
        assert.equal(bodies.length, 2);
        assert.deepEqual(bodies[1].messages[2].tool_calls, [{
            id: "fixture-call", type: "function", function: { name: "fixture_unavailable", arguments: '{"query":"fixture"}' },
        }]);
        assert.equal(bodies[1].messages[3].role, "tool");
        assert.equal(bodies[1].messages[3].tool_call_id, "fixture-call");
        assert.match(String(bodies[1].messages[3].content), /^Refused:/);
    });

    await check("Muse Spark Responses model is rejected before any fetch", async () => {
        const zen = getProvider("opencode-zen")!;
        const muse = zen.chatModels.find((entry) => entry.id === "muse-spark-1.3-contributor-free");
        assert.ok(muse, "Muse Spark must be represented in the disabled catalogue.");
        let fetches = 0;
        globalThis.fetch = async () => {
            fetches++;
            throw new Error("Muse Spark must not reach Chat Completions.");
        };
        await assert.rejects(openaiCompatChat({ ...base, provider: { ...zen, unavailableReason: undefined }, model: muse }), /responses/i);
        assert.equal(fetches, 0);
    });

    console.log(`\n${checks} adapter checks passed. No live provider or database calls were made.`);
} finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
