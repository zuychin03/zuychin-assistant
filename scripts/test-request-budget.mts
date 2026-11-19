import assert from "node:assert/strict";

const fixtureEnv: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: "https://budget-fixture.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "budget-fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "budget-fixture-service",
    GEMINI_API_KEY: "budget-fixture-gemini",
    GROQ_API_KEY: "budget-fixture-groq",
    KILO_API_KEY: "budget-fixture-kilo",
};
const previousEnv = new Map(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
let checks = 0;

type RequestBody = {
    model: string;
    max_tokens?: number;
    max_completion_tokens?: number;
    tools?: unknown[];
    messages: { role: string; content: unknown; name?: string }[];
};

function streamResponse(deltas: unknown[], options: { finishReason?: string; totalTokens?: number } = {}): Response {
    const frames: unknown[] = deltas.map((delta) => ({ choices: [{ delta }] }));
    frames.push({ choices: [{ delta: {}, finish_reason: options.finishReason ?? "stop" }] });
    if (options.totalTokens !== undefined) {
        frames.push({ choices: [], usage: { prompt_tokens: options.totalTokens - 10, completion_tokens: 10, total_tokens: options.totalTokens } });
    }
    const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    }), { headers: { "Content-Type": "text/event-stream" } });
}

function intercept(responses: Response[]): { bodies: RequestBody[]; urls: string[] } {
    const bodies: RequestBody[] = [];
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
        urls.push(String(input));
        bodies.push(JSON.parse(init?.body as string) as RequestBody);
        const response = responses.shift();
        assert.ok(response, "Unexpected extra request; no network access is permitted.");
        return response;
    };
    return { bodies, urls };
}

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

try {
    Object.assign(process.env, fixtureEnv);
    globalThis.fetch = async () => { throw new Error("Unexpected fetch; this suite is offline."); };
    console.warn = () => {};
    const budget = await import("../src/lib/ai/request-budget");
    const { MIN_REPLY_TOKENS, RequestLimitError, budgetKey, canRepeatElsewhere, estimateTokens, fallbackNote, planRequest, recordTokens, resetRequestBudgetsForTests, stoppedAfterTools, tokensUsedInLastMinute } = budget;
    const { openaiCompatChat } = await import("../src/lib/ai/openai-compat");
    const { getProvider, resolveEmbedding } = await import("../src/lib/ai/providers");
    const { READ_ONLY_TOOLS } = await import("../src/lib/ai/mcp-service");

    const groq = getProvider("groq")!;
    assert.equal(groq.requestTokenLimit, 8000);
    const model = { free: true, id: "openai/gpt-oss-20b", label: "GPT OSS 20B", name: "gpt-oss-20b", supportsTools: true, supportsVision: false, supportsThinking: true, supportsSearch: true };
    const key = budgetKey("groq", model.id);
    const base = {
        provider: groq,
        model,
        systemText: "Local budget fixture.",
        userText: "Return a short fixture reply.",
        embRef: resolveEmbedding("nvidia/nemotron-3-embed-1b"),
        allowTools: new Set(["get_current_time"]),
    };
    const refusal = async (run: Promise<unknown>): Promise<InstanceType<typeof RequestLimitError>> => {
        try {
            await run;
        } catch (err) {
            assert.ok(err instanceof RequestLimitError, `expected a RequestLimitError, got ${String(err)}`);
            return err;
        }
        assert.fail("expected the request to be refused");
    };

    await check("estimates run about 3.5 characters a token and round up", () => {
        assert.equal(estimateTokens("x".repeat(68)), 20);
        assert.equal(estimateTokens({ a: "b" }), 3);
    });

    await check("a request that cannot fit the minute with a minimal reply is refused outright", () => {
        resetRequestBudgetsForTests();
        const plan = planRequest(8000, "p::m", 8000 - MIN_REPLY_TOKENS + 1);
        assert.deepEqual(plan, { ok: false, reason: "request", used: 0 });
        assert.equal(planRequest(8000, "p::m", 8000 - MIN_REPLY_TOKENS).ok, true);
    });

    await check("the reply cap is the room left this minute, or a smaller requested cap", () => {
        resetRequestBudgetsForTests();
        assert.deepEqual(planRequest(8000, "p::m", 3000), { ok: true, maxTokens: 5000, used: 0 });
        assert.deepEqual(planRequest(8000, "p::m", 3000, 2000), { ok: true, maxTokens: 2000, used: 0 });
        assert.deepEqual(planRequest(8000, "p::m", 3000, 9000), { ok: true, maxTokens: 5000, used: 0 });
    });

    await check("usage in the last minute counts, and expires after 60 seconds", () => {
        resetRequestBudgetsForTests();
        recordTokens("p::m", 5000, 1_000_000);
        recordTokens("p::other", 7000, 1_000_000);
        assert.deepEqual(planRequest(8000, "p::m", 2500, undefined, 1_030_000), { ok: false, reason: "minute", used: 5000 });
        assert.deepEqual(planRequest(8000, "p::m", 1900, undefined, 1_030_000), { ok: true, maxTokens: 1100, used: 5000 });
        assert.equal(planRequest(8000, "p::m", 2000, undefined, 1_030_000).ok, false, "1000 tokens of room is under the minimal reply");
        assert.equal(tokensUsedInLastMinute("p::m", 1_059_999), 5000);
        assert.equal(tokensUsedInLastMinute("p::m", 1_060_000), 0);
        assert.deepEqual(planRequest(8000, "p::m", 2500, undefined, 1_060_000), { ok: true, maxTokens: 5500, used: 0 });
        recordTokens("p::m", 0, 1_060_000);
        recordTokens("p::m", Number.NaN, 1_060_000);
        assert.equal(tokensUsedInLastMinute("p::m", 1_060_000), 0, "empty usage is not recorded");
    });

    await check("a normal Groq request sends max_completion_tokens sized to the room and records the reported usage", async () => {
        resetRequestBudgetsForTests();
        const { bodies, urls } = intercept([streamResponse([{ content: "Fixture reply." }], { totalTokens: 1200 })]);
        assert.equal(await openaiCompatChat(base), "Fixture reply.");
        assert.deepEqual(urls, ["https://api.groq.com/openai/v1/chat/completions"]);
        assert.equal(bodies[0].max_tokens, undefined);
        assert.equal(bodies[0].max_completion_tokens, 8000 - estimateTokens({ messages: bodies[0].messages, tools: bodies[0].tools }));
        assert.equal(tokensUsedInLastMinute(key), 1200);
    });

    await check("a smaller saved reply cap is kept", async () => {
        resetRequestBudgetsForTests();
        const { bodies } = intercept([streamResponse([{ content: "Fixture reply." }])]);
        await openaiCompatChat({ ...base, genParams: { maxTokens: 2000 } });
        assert.equal(bodies[0].max_completion_tokens, 2000);
        assert.ok(tokensUsedInLastMinute(key) > MIN_REPLY_TOKENS, "unknown usage is charged at the estimate plus a minimal reply");
    });

    await check("an oversized Groq prompt is refused before any request, with no retry without tools", async () => {
        resetRequestBudgetsForTests();
        const { bodies } = intercept([]);
        const err = await refusal(openaiCompatChat({ ...base, systemText: "x".repeat(30_000) }));
        assert.equal(bodies.length, 0);
        assert.equal(err.reason, "request");
        assert.equal(err.limit, 8000);
        assert.deepEqual(err.toolsRun, []);
        assert.match(err.message, /^Groq: this request \(about \d+ tokens\) does not fit the free tier's 8000 tokens per minute for openai\/gpt-oss-20b\.$/);
    });

    await check("a model that spent its minute is refused before any request", async () => {
        resetRequestBudgetsForTests();
        recordTokens(key, 7000);
        const { bodies } = intercept([]);
        const err = await refusal(openaiCompatChat(base));
        assert.equal(bodies.length, 0);
        assert.equal(err.reason, "minute");
        assert.equal(err.usedTokens, 7000);
        assert.equal(tokensUsedInLastMinute(budgetKey("groq", "openai/gpt-oss-120b")), 0, "budgets are per model");
    });

    await check("Groq's own 413 or 429 becomes a limit error and sits the model out for the minute", async () => {
        for (const status of [413, 429]) {
            resetRequestBudgetsForTests();
            const { bodies } = intercept([new Response('{"error":{"message":"Request too large on tokens per minute (TPM)"}}', { status })]);
            const err = await refusal(openaiCompatChat(base));
            assert.equal(bodies.length, 1, "not retried without tools");
            assert.equal(err.reason, "upstream");
            assert.equal(err.status, status);
            assert.equal(tokensUsedInLastMinute(key), 8000);
            intercept([]);
            assert.equal((await refusal(openaiCompatChat(base))).reason, "minute");
        }
    });

    await check("a tool round that runs out of minute reports the tools already run", async () => {
        resetRequestBudgetsForTests();
        const { bodies } = intercept([
            streamResponse([{ tool_calls: [{ index: 0, id: "time-call", function: { name: "get_current_time", arguments: "{}" } }] }], { finishReason: "tool_calls", totalTokens: 7000 }),
        ]);
        const err = await refusal(openaiCompatChat(base));
        assert.equal(bodies.length, 1);
        assert.equal(err.reason, "minute");
        assert.deepEqual(err.toolsRun, ["get_current_time"]);
        assert.equal(canRepeatElsewhere(err, READ_ONLY_TOOLS), true, "a read-only turn can move to another model");
    });

    await check("a tool round that fits strips message names for Groq and caps the second reply", async () => {
        resetRequestBudgetsForTests();
        const { bodies } = intercept([
            streamResponse([{ tool_calls: [{ index: 0, id: "time-call", function: { name: "get_current_time", arguments: "{}" } }] }], { finishReason: "tool_calls", totalTokens: 2000 }),
            streamResponse([{ content: "Time handled." }], { totalTokens: 2100 }),
        ]);
        assert.equal(await openaiCompatChat(base), "Time handled.");
        assert.equal(bodies.length, 2);
        const tool = bodies[1].messages.find((message) => message.role === "tool");
        assert.ok(tool && !("name" in tool));
        // Estimated before the name strip, so a few tokens under the exact room.
        const room = 8000 - 2000 - estimateTokens({ messages: bodies[1].messages, tools: bodies[1].tools });
        assert.ok(bodies[1].max_completion_tokens! <= room && bodies[1].max_completion_tokens! > room - 16, `${bodies[1].max_completion_tokens} vs ${room}`);
        assert.equal(tokensUsedInLastMinute(key), 4100);
    });

    await check("only read-only tools let a refused turn move to another model", () => {
        const err = new RequestLimitError("minute", "Groq", model.id, 8000, 1500, 7000);
        assert.equal(canRepeatElsewhere(err, READ_ONLY_TOOLS), true);
        err.toolsRun = ["search_web", "add_todo"];
        assert.equal(canRepeatElsewhere(err, READ_ONLY_TOOLS), false);
        assert.equal(canRepeatElsewhere(new Error("Groq 500"), READ_ONLY_TOOLS), false);
        assert.equal(stoppedAfterTools(err).message, `${err.message} This turn had already run search_web, add_todo, so it was not repeated on another model. Ask again in a minute, or pick another model.`);
        assert.equal(fallbackNote(err, "Gemini 3.8 Flash"), "\n\n_[Groq's free tier could not take this request, so Gemini 3.8 Flash answered.]_");
    });

    await check("providers without a limit are untouched", async () => {
        resetRequestBudgetsForTests();
        const kilo = getProvider("kilo")!;
        assert.equal(kilo.requestTokenLimit, undefined);
        const { bodies } = intercept([streamResponse([{ content: "Fixture reply." }], { totalTokens: 50_000 })]);
        await openaiCompatChat({ ...base, provider: kilo, model: kilo.chatModels[0], systemText: "x".repeat(30_000) });
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0].max_tokens, undefined);
        assert.equal(tokensUsedInLastMinute(budgetKey("kilo", kilo.chatModels[0].id)), 0);
    });

    console.log(`\n${checks} request budget checks passed. No live provider or database calls were made.`);
} finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
