import assert from "node:assert/strict";
import fs from "node:fs";
import {
    cleanLabel,
    labelFromId,
    listProviderModels,
    parseGeminiModels,
    parseKiloModels,
    parseOpenAiModelList,
    parseOpenCodeModels,
    parseOpenRouterModels,
    selectDiscoverable,
    shortNameFor,
    uniqueShortName,
    type ProviderDiscovery,
} from "../src/lib/ai/catalogue/sources";
import { getProvider, retiredChatModelIds } from "../src/lib/ai/providers";

const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(`fixtures/model-lists/${name}.json`, "utf8"));
const ids = (models: { modelId: string }[]) => models.map((model) => model.modelId);
let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

await check("OpenRouter: price decides free, routers and audio models are not chat", () => {
    const models = parseOpenRouterModels(fixture("openrouter"));
    const gemma = models.find((model) => model.modelId === "google/gemma-4-31b-it:free")!;
    assert.equal(gemma.free, true);
    assert.equal(gemma.chat, true);
    assert.equal(gemma.label, "Gemma 4 31B (free)");
    assert.equal(gemma.developer, "Google");
    assert.equal(gemma.listedTools, true);
    assert.equal(gemma.listedThinking, true);
    assert.equal(gemma.maxOutputTokens, 32768);
    assert.equal(gemma.contextTokens, 262144);
    assert.deepEqual(gemma.inputs, ["Image", "Text", "Video"]);
    assert.equal(models.find((model) => model.modelId === "google/gemma-4-26b-a4b-it")!.free, false);
    assert.equal(models.find((model) => model.modelId === "openrouter/free")!.chat, false);
    assert.equal(models.find((model) => model.modelId === "google/lyria-3-clip-preview")!.chat, false);
    const discovery: ProviderDiscovery = { source: "openrouter", include: "free", pricing: "listed" };
    assert.deepEqual(ids(selectDiscoverable(models, discovery)), ["google/gemma-4-31b-it:free", "nvidia/nemotron-3.5-lightning:free"]);
});

await check("Kilo: isFree decides free and the training flag is kept", () => {
    const models = parseKiloModels(fixture("kilo"));
    const discovery: ProviderDiscovery = { source: "kilo", include: "free", pricing: "listed" };
    const tracked = selectDiscoverable(models, discovery);
    assert.deepEqual(ids(tracked), ["nvidia/nemotron-3.5-lightning:free", "stealth/glyph-cluster"]);
    assert.equal(tracked[0].mayTrain, true);
    assert.equal(tracked[0].maxOutputTokens, 65536);
    assert.equal(models.find((model) => model.modelId === "kilo-auto/free")!.chat, false);
});

await check("NIM: ids only, every model free, embeddings and guards left out", () => {
    const models = parseOpenAiModelList(fixture("nvidia-nim"), true);
    const discovery: ProviderDiscovery = { source: "openai-list", include: "all", pricing: "all-free" };
    const tracked = selectDiscoverable(models, discovery);
    assert.deepEqual(ids(tracked).sort(), ["poolside/laguna-xs-2.1", "stepfun-ai/step-5-preview", "z-ai/glm-5.3-flash"]);
    const glm = tracked.find((model) => model.modelId === "z-ai/glm-5.3-flash")!;
    assert.equal(glm.free, true);
    assert.equal(glm.label, "Glm 5.3 Flash (free)");
    assert.equal(glm.listedTools, null);
    assert.equal(glm.maxOutputTokens, null);
});

await check("Gemini: non-chat families, -latest aliases and retired ids are left out", () => {
    const paid = parseGeminiModels(fixture("gemini"), false);
    const discovery: ProviderDiscovery = { source: "gemini", include: "all", pricing: "all-paid" };
    const retired = retiredChatModelIds("gemini");
    assert.ok(retired.has("gemini-3.5-flash"));
    const tracked = selectDiscoverable(paid, discovery, retired);
    assert.deepEqual(ids(tracked).sort(), ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemma-4-31b-it"]);
    const flash = tracked.find((model) => model.modelId === "gemini-3.8-flash")!;
    assert.equal(flash.free, false);
    assert.equal(flash.listedThinking, true);
    assert.equal(flash.maxOutputTokens, 65536);
    assert.equal(flash.label, "Gemini 3.8 Flash");
    assert.equal(parseGeminiModels(fixture("gemini"), true).find((model) => model.modelId === "gemini-3.8-flash")!.label, "Gemini 3.8 Flash (free)");
});

await check("DeepSeek: paid key, limits, modalities and effort are read", () => {
    const models = parseOpenAiModelList(fixture("deepseek"), false);
    const flash = models.find((model) => model.modelId === "deepseek-flash")!;
    assert.equal(flash.free, false);
    assert.equal(flash.chat, true);
    assert.equal(flash.maxOutputTokens, 393216);
    assert.equal(flash.contextTokens, 1048576);
    assert.deepEqual(flash.inputs, ["Text", "Image"]);
    assert.equal(flash.listedThinking, true);
});

await check("Groq: free key, inactive, speech and guard models left out, completion limit read", () => {
    const models = parseOpenAiModelList(fixture("groq"), true);
    const groq = getProvider("groq")!;
    const tracked = selectDiscoverable(models, groq.discovery!, retiredChatModelIds("groq"));
    assert.deepEqual(ids(tracked).sort(), ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]);
    const qwen = tracked.find((model) => model.modelId === "qwen/qwen3.8-27b")!;
    assert.equal(qwen.free, true);
    assert.equal(qwen.maxOutputTokens, 16384);
    assert.equal(qwen.contextTokens, 131072);
    assert.equal(qwen.developer, "Alibaba Cloud");
    assert.equal(models.find((model) => model.modelId === "gemma2-9b-it")!.chat, false);
});

await check("Agnes AI: free key, image and video models and the retired 2.0 and 2.5 left out", () => {
    const models = parseOpenAiModelList(fixture("agnes"), true);
    const agnes = getProvider("agnes")!;
    const tracked = selectDiscoverable(models, agnes.discovery!, retiredChatModelIds("agnes"));
    assert.deepEqual(ids(tracked).sort(), ["agnes-1.5-flash", "agnes-3.0-flash"]);
    assert.ok(tracked.every((model) => model.free && model.developer === "Agnes AI"));
    assert.deepEqual(agnes.chatModels, [], "no built-in models, so automatic routes wait for Approve");
});

await check("OpenCode Console: only paid Chat Completions models are chat, with price, limits and inputs read", () => {
    const models = parseOpenCodeModels(fixture("opencode"));
    const opencode = getProvider("opencode-zen")!;
    const tracked = selectDiscoverable(models, opencode.discovery!, retiredChatModelIds("opencode-zen"));
    assert.deepEqual(ids(tracked), ["glm-5.3-flash", "deepseek-v4.1-flash", "kimi-k2.5"]);
    const glm = tracked[0];
    assert.equal(glm.free, false);
    assert.equal(glm.label, "GLM-5.3-Flash");
    assert.equal(glm.developer, "zhipuai");
    assert.equal(glm.contextTokens, 1000000);
    assert.equal(glm.maxOutputTokens, 131072);
    assert.deepEqual(glm.inputs, ["Text", "Image", "Video"]);
    assert.equal(glm.listedTools, true);
    assert.equal(glm.listedThinking, true);
    assert.equal(glm.listedStructured, true);
    assert.equal(tracked.find((model) => model.modelId === "kimi-k2.5")!.listedStructured, null);
    const free = models.find((model) => model.modelId === "big-pickle")!;
    assert.equal(free.free, true);
    assert.equal(free.chat, false, "free models answer 403 outside OpenCode");
    for (const id of ["claude-haiku-5-5", "gpt-6-luna", "gemini-3.5-flash-lite"]) {
        assert.equal(models.find((model) => model.modelId === id)!.chat, false, `${id} needs a transport this app lacks`);
    }
});

await check("labels and short names", () => {
    assert.equal(cleanLabel("NVIDIA: Nemotron 3.5 Lightning (free)", true), "Nemotron 3.5 Lightning (free)");
    assert.equal(cleanLabel("Gemma 4 26B A4B (free)", false), "Gemma 4 26B A4B");
    assert.equal(labelFromId("stepfun-ai/step-5-preview"), "Step 5 Preview");
    assert.equal(shortNameFor("nvidia/nemotron-3.5-lightning:free"), "nemotron-3.5-lightning");
    assert.equal(shortNameFor("reflection/beam-free"), "beam");
    assert.equal(shortNameFor("gemini-2.5-flash", "-free"), "gemini-2.5-flash-free");
    assert.equal(uniqueShortName("gemma-4", new Set(["gemma-4", "gemma-4-2"])), "gemma-4-3");
    assert.equal(uniqueShortName("fresh", new Set(["gemma-4"])), "fresh");
});

type Call = { url: string; headers: Record<string, string> };
function stubFetch(responses: (url: string) => { status: number; body: unknown } | Error, calls: Call[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
        const result = responses(url);
        if (result instanceof Error) throw result;
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
}

await check("listing: OpenAI-style providers send the bearer key and extra headers", async () => {
    const calls: Call[] = [];
    const openrouter = getProvider("openrouter")!;
    const result = await listProviderModels(openrouter, openrouter.discovery!, "test-key", { fetchImpl: stubFetch(() => ({ status: 200, body: fixture("openrouter") }), calls) });
    assert.ok(result.ok);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
    assert.equal(calls[0].headers.Authorization, "Bearer test-key");
    assert.ok(calls[0].headers["X-Title"]);
});

await check("listing: Groq, Agnes AI and OpenCode Console list from their own base URL with the bearer key", async () => {
    for (const [id, name, url] of [
        ["groq", "groq", "https://api.groq.com/openai/v1/models"],
        ["agnes", "agnes", "https://apihub.agnes-ai.com/v1/models"],
        ["opencode-zen", "opencode", "https://opencode.ai/inference/openai/v1/models"],
    ] as const) {
        const calls: Call[] = [];
        const provider = getProvider(id)!;
        const result = await listProviderModels(provider, provider.discovery!, "test-key", { fetchImpl: stubFetch(() => ({ status: 200, body: fixture(name) }), calls) });
        assert.ok(result.ok && result.models.length > 0, id);
        assert.equal(calls[0].url, url);
        assert.equal(calls[0].headers.Authorization, "Bearer test-key");
    }
});

await check("listing: Gemini follows page tokens and uses its key header", async () => {
    const calls: Call[] = [];
    const all = (fixture("gemini") as { models: unknown[] }).models;
    const fetchImpl = stubFetch((url) => url.includes("pageToken=next")
        ? { status: 200, body: { models: all.slice(3) } }
        : { status: 200, body: { models: all.slice(0, 3), nextPageToken: "next" } }, calls);
    const gemini = getProvider("gemini")!;
    const result = await listProviderModels(gemini, gemini.discovery!, "test-key", { fetchImpl });
    assert.ok(result.ok);
    assert.equal(result.models.length, all.length);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers["x-goog-api-key"], "test-key");
    assert.equal(calls[0].headers.Authorization, undefined);
});

await check("listing: HTTP errors, bad bodies and timeouts are failures, not empty lists", async () => {
    const nim = getProvider("nvidia-nim")!;
    const denied = await listProviderModels(nim, nim.discovery!, "bad", { fetchImpl: stubFetch(() => ({ status: 401, body: { error: { message: "Unauthorized" } } }), []) });
    assert.deepEqual(denied, { ok: false, status: 401, error: "Unauthorized" });
    const malformed = await listProviderModels(nim, nim.discovery!, "key", { fetchImpl: stubFetch(() => ({ status: 200, body: { models: [] } }), []) });
    assert.equal(malformed.ok, false);
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const slow = await listProviderModels(nim, nim.discovery!, "key", { fetchImpl: stubFetch(() => timeout, []) });
    assert.deepEqual(slow, { ok: false, status: null, error: "Listing timed out." });
});

console.log(`${checks} catalogue source checks passed`);
