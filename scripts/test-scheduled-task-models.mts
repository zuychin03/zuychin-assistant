import assert from "node:assert/strict";
import type { ScheduledTask } from "../src/lib/tasks/store";

const PAID_KEY = "paid-gemini-fixture";
const NIM_KEY = "nim-fixture";
const env: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: "https://scheduled-task-tests.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: PAID_KEY,
    GEMINI_FREE_API_KEY: "free-gemini-fixture",
    NVIDIA_NIM_API_KEY: NIM_KEY,
    OPENROUTER_API_KEY: "openrouter-fixture",
    KILO_API_KEY: "kilo-fixture",
    KNOWLEDGE_EMBEDDING_MODEL: "",
    TELEGRAM_BOT_TOKEN: "telegram-fixture",
    TELEGRAM_CHAT_ID: "1001",
};
const savedEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);

// The stored Telegram choice is the free route a scheduled task used to inherit.
const PROFILE = {
    id: "profile-1",
    display_name: "Owner",
    system_prompt: "You are a fixture assistant.",
    preferences: { channelModels: { telegram: "nvidia-nim::z-ai/glm-5.3-flash" } },
};

interface Call { url: URL; method: string; headers: Headers; body: string }
const calls: Call[] = [];
const unexpected: string[] = [];
const taskFixtures = new Map<string, ScheduledTask>();
let answerGemini: (model: string, body: string, stream: boolean) => unknown = () => text("Fixture reply");

function text(value: string) {
    return {
        candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
    };
}

function functionCall(name: string, args: Record<string, unknown>) {
    return { candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP", index: 0 }] };
}

function completionStream(content: string): Response {
    const frames = [{ choices: [{ delta: { content } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
    return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
    );
}

function supabaseResponse(url: URL, method: string, headers: Headers, body: string): Response {
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "Content-Range": "*/0" } });
    if (["assistant_start_task_run", "assistant_claim_task_delivery", "assistant_finish_task_run"].some(name => url.pathname.endsWith(`/rpc/${name}`))) return Response.json(true);
    if (url.pathname.endsWith("/rpc/assistant_context_snapshot")) return Response.json({ messages: [], revision: "fixture-empty", summary: null, project_id: null });
    if (url.pathname.endsWith("/rpc/assistant_claim_task_run")) {
        const value = taskFixtures.get(JSON.parse(body).p_task_id)!;
        return Response.json({ status: "accepted", run: { id: `claimed-${value.id}`, task_id: value.id, user_profile_id: PROFILE.id, task_title: value.title, trigger: "manual", status: "running", started_at: new Date().toISOString(), finished_at: null, detail: null,
            task_snapshot: { id: value.id, title: value.title, instruction: value.instruction, schedule_type: value.scheduleType, cron: value.cron, run_at: value.runAt, timezone: value.timezone, channel: value.channel, conversation_id: value.conversationId, agent_mode: value.agentMode, enabled: value.enabled, next_run_at: value.nextRunAt, last_run_at: value.lastRunAt, last_status: value.lastStatus, last_result: value.lastResult, created_at: value.createdAt, user_profile_id: PROFILE.id } } });
    }
    const wantsObject = (headers.get("Accept") ?? "").includes("vnd.pgrst.object+json");
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    if (table === "user_profiles") return Response.json(wantsObject ? PROFILE : [PROFILE]);
    if (!wantsObject) return Response.json([]);
    if (table === "conversations") return Response.json({ id: "conv-1", title: "Existing chat", project_id: null, projects: null });
    if (table === "agent_runs") return Response.json({ id: "run-1", root_run_id: "run-1" });
    return Response.json({ id: `row-${calls.length}` });
}

globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method, headers, body });

    if (url.hostname === "scheduled-task-tests.supabase.co") return supabaseResponse(url, method, headers, body);
    if (url.hostname === "generativelanguage.googleapis.com") {
        const [model, verb] = (url.pathname.split("/models/")[1] ?? "").split(":");
        const stream = verb === "streamGenerateContent";
        const payload = answerGemini(model, body, stream);
        return stream
            ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
            : Response.json(payload);
    }
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname === "/v1/embeddings") {
        return Response.json({ data: [{ embedding: Array.from({ length: 2048 }, (_, i) => ((i % 7) + 1) / 10) }] });
    }
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname === "/v1/chat/completions") {
        return completionStream("Free NIM reply");
    }
    if (url.hostname === "api.telegram.org") return Response.json({ ok: true, result: { message_id: 1 } });
    unexpected.push(`${method} ${url.origin}${url.pathname}`);
    throw new Error(`Unexpected request: ${method} ${url.origin}${url.pathname}`);
};

const geminiCalls = () => calls.filter((call) => call.url.hostname === "generativelanguage.googleapis.com");
const completionCalls = () => calls.filter((call) => call.url.pathname.endsWith("/chat/completions"));
const geminiModel = (call: Call) => (call.url.pathname.split("/models/")[1] ?? "").split(":")[0];

function assertPaidGeminiOnly() {
    assert.deepEqual(completionCalls().map((call) => call.url.host), [], "no OpenAI-compatible chat route may be called");
    assert.ok(geminiCalls().length > 0, "the turn must reach Gemini");
    for (const call of geminiCalls()) assert.equal(call.headers.get("x-goog-api-key"), PAID_KEY);
}

// Fact extraction runs after the reply without being awaited; wait until the
// fixture network goes quiet so its calls land in the right check.
async function settle(): Promise<void> {
    let seen = -1;
    for (let attempt = 0; attempt < 100 && seen !== calls.length; attempt++) {
        seen = calls.length;
        await new Promise((resolve) => setTimeout(resolve, 60));
    }
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    const value: ScheduledTask = {
        id: "task-1",
        title: "Stretch reminder",
        instruction: "Remind me to stretch and drink water",
        scheduleType: "recurring",
        cron: "0 9 * * 1-5",
        runAt: null,
        timezone: "Australia/Sydney",
        channel: "telegram",
        conversationId: null,
        agentMode: false,
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
        lastResult: null,
        createdAt: new Date().toISOString(),
        userProfileId: PROFILE.id,
        ...overrides,
    };
    taskFixtures.set(value.id, value);
    return value;
}

const memoryExtraction = (body: string) => body.includes("You maintain a long-term memory");
let passed = 0;

async function check(name: string, run: () => Promise<void>) {
    await settle();
    calls.length = 0;
    unexpected.length = 0;
    await run();
    await settle();
    assert.deepEqual(unexpected, [], "every request must be answered by a local fixture");
    passed++;
    console.log(`PASS ${name}`);
}

try {
    const { resolvePaidChat, resolveEmbedding, getProviderApiKey } = await import("../src/lib/ai/providers");
    const { runWorker } = await import("../src/lib/ai/agent/worker");
    const { ragChat } = await import("../src/lib/ai/rag-service");
    const { runScheduledTask } = await import("../src/lib/tasks/runner");
    const embRef = resolveEmbedding("nvidia/nemotron-3-embed-1b");

    await check("the paid resolver keeps a paid choice and replaces free ones", async () => {
        const fromFree = resolvePaidChat("nvidia-nim::z-ai/glm-5.3-flash");
        assert.deepEqual([fromFree.provider.id, fromFree.model.id], ["gemini", "gemini-3.5-flash-lite"]);
        assert.equal(getProviderApiKey(fromFree.provider), PAID_KEY);
        const kept = resolvePaidChat("gemini::gemini-3.8-flash");
        assert.deepEqual([kept.provider.id, kept.model.id], ["gemini", "gemini-3.8-flash"]);
        const fromFreeTier = resolvePaidChat("gemini-free::gemini-3.8-flash");
        assert.deepEqual([fromFreeTier.provider.id, fromFreeTier.model.id], ["gemini", "gemini-3.5-flash-lite"]);
        assert.equal(resolvePaidChat(undefined).provider.id, "gemini");
    });

    await check("without the paid key the resolver fails rather than pick a free route", async () => {
        delete process.env.GEMINI_API_KEY;
        try {
            assert.throws(() => resolvePaidChat("nvidia-nim::z-ai/glm-5.3-flash"), /no API key/);
        } finally {
            process.env.GEMINI_API_KEY = PAID_KEY;
        }
    });

    const workerParams = {
        objective: "Summarise the fixture",
        modelHint: "glm-5.3-flash",
        complexity: "complex" as const,
        contextBlock: "Fixture context.",
        embRef,
        toolCtx: {},
    };

    await check("a paid-only worker ignores its free hint and uses the paid key", async () => {
        answerGemini = (model) => text(`Worker on ${model}`);
        const result = await runWorker({ ...workerParams, paidOnly: true });
        assert.equal(result.model, "gemini-3.8-flash");
        assert.equal(result.output, "Worker on gemini-3.8-flash");
        assertPaidGeminiOnly();
        assert.deepEqual(geminiCalls().map(geminiModel), ["gemini-3.8-flash"]);
        assert.ok(calls.every((call) => call.url.hostname !== "integrate.api.nvidia.com"));
    });

    await check("control: without paidOnly the same worker starts on the free NVIDIA route", async () => {
        const result = await runWorker(workerParams);
        assert.equal(result.model, "z-ai/glm-5.3-flash");
        assert.equal(result.output, "Free NIM reply");
        assert.equal(completionCalls().length, 1);
        assert.equal(completionCalls()[0].headers.get("Authorization"), `Bearer ${NIM_KEY}`);
        assert.equal(JSON.parse(completionCalls()[0].body).model, "z-ai/glm-5.3-flash");
    });

    await check("control: a Telegram turn without paidOnly follows the free channel preference", async () => {
        answerGemini = () => text('{"operations":[]}');
        const { reply } = await ragChat({ message: "Remind me to stretch", channel: "telegram" });
        assert.equal(reply, "Free NIM reply");
        assert.equal(completionCalls().length, 1);
        assert.equal(JSON.parse(completionCalls()[0].body).model, "z-ai/glm-5.3-flash");
    });

    await check("a recurring Telegram task runs on the paid key despite the free channel default", async () => {
        answerGemini = (_model, body, stream) => memoryExtraction(body)
            ? text('{"operations":[]}')
            : text(stream ? "Paid Gemini reply" : "Draft reply");
        const result = await runScheduledTask(task());
        await settle();
        assert.equal(result.status, "ok");
        assertPaidGeminiOnly();
        assert.ok(geminiCalls().every((call) => geminiModel(call) === "gemini-3.5-flash-lite"));
        const sent = calls.filter((call) => call.url.hostname === "api.telegram.org");
        assert.equal(sent.length, 1);
        assert.match(JSON.parse(sent[0].body).text, /Paid Gemini reply/);
        const recorded = calls.find((call) => call.url.pathname.endsWith("/rpc/assistant_finish_task_run"));
        assert.equal(JSON.parse(recorded?.body ?? "{}").p_status, "ok");
        assert.equal(calls.some(call => call.method === "PATCH" && call.url.pathname === "/rest/v1/scheduled_tasks"), false);
    });

    await check("an agent-mode task keeps the lead and its workers on the paid key", async () => {
        answerGemini = (model, body) => {
            if (memoryExtraction(body)) return text('{"operations":[]}');
            if (model === "gemini-3.8-flash") return text("Worker finding");
            if (!body.includes("autonomous agent")) return text("Unrouted prompt");
            return body.includes("functionResponse")
                ? text("Paid agent reply")
                : functionCall("run_subagents", {
                    tasks: [{ objective: "Collect the fixture fact", model: "glm-5.3-flash", complexity: "complex" }],
                });
        };
        const result = await runScheduledTask(task({
            id: "task-2", title: "Weekly digest", channel: "web", conversationId: "conv-1", agentMode: true,
        }));
        await settle();
        assert.equal(result.status, "ok");
        assertPaidGeminiOnly();
        assert.ok(geminiCalls().some((call) => geminiModel(call) === "gemini-3.8-flash"), "the worker ran on paid Gemini");
        const saved = calls
            .filter((call) => call.method === "POST" && call.url.pathname === "/rest/v1/messages")
            .map((call) => JSON.parse(call.body).content);
        assert.ok(saved.includes("Paid agent reply"));
    });

    await check("a task without the paid key fails instead of reaching a free route", async () => {
        delete process.env.GEMINI_API_KEY;
        try {
            const result = await runScheduledTask(task({ id: "task-3" }));
            await settle();
            assert.equal(result.status, "error");
            assert.match(result.detail, /no API key/);
            assert.equal(completionCalls().length, 0);
            assert.equal(geminiCalls().length, 0);
            assert.equal(calls.filter((call) => call.url.hostname === "api.telegram.org").length, 0);
        } finally {
            process.env.GEMINI_API_KEY = PAID_KEY;
        }
    });

    console.log(`\n${passed} scheduled-task model checks passed; every request was answered by a local fixture.`);
} finally {
    // Not the original fetch: stray background work must fail here, never reach a real host.
    globalThis.fetch = async (input) => { throw new Error(`Late request after the suite: ${String(input)}`); };
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
