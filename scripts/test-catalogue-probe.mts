import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { probeModel, solidPng, type ProbeStepName, type ProbeTarget } from "../src/lib/ai/catalogue/probe";
import { collectModelObservations } from "../src/lib/ai/model-observations";
import { getProvider } from "../src/lib/ai/providers";

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown>; step: ProbeStepName };
type Reply = Response | Error | "hang";

function sse(frames: unknown[], status = 200): Response {
    const text = frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
    return new Response(text, { status, headers: { "Content-Type": "text/event-stream" } });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const text = (content: string) => sse([{ choices: [{ delta: { content } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
const reasoningOnly = () => sse([{ choices: [{ delta: { reasoning_content: "The user wants OK." } }] }, "[DONE]"]);
const call = (name = "probe_echo", args = "{\"text\":\"zuychin\"}") => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args.slice(0, 4) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(4) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
]);
const geminiText = (value: string) => sse([{ candidates: [{ content: { parts: [{ text: "thinking about it", thought: true }, { text: value }] } }] }]);
const geminiCall = () => sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "probe_echo", args: { text: "zuychin" } } }] } }] }]);

function stepOf(body: Record<string, unknown>): ProbeStepName {
    if (body.toolConfig) return (body.toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig.mode === "ANY" ? "forced" : "tools";
    if (body.tool_choice) return body.tool_choice === "auto" ? "tools" : "forced";
    const contents = body.contents as { parts: unknown[] }[] | undefined;
    if (contents) return contents[0].parts.length > 1 ? "vision" : "chat";
    const messages = body.messages as { content: unknown }[];
    return Array.isArray(messages[0].content) ? "vision" : "chat";
}

function stub(replies: Partial<Record<ProbeStepName, () => Reply>>, sent: Sent[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const step = stepOf(body);
        sent.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body, step });
        const reply = replies[step]?.() ?? json(500, { error: { message: `no stub for ${step}` } });
        if (reply === "hang") {
            // A real request holds a socket open; AbortSignal.timeout alone does not keep the process alive.
            const keepAlive = setTimeout(() => undefined, 60_000);
            return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => {
                clearTimeout(keepAlive);
                reject(init.signal!.reason);
            }));
        }
        if (reply instanceof Error) throw reply;
        return reply;
    }) as typeof fetch;
}

const target = (providerId: string, modelId: string, checkVision = true): ProbeTarget => ({ provider: getProvider(providerId)!, modelId, apiKey: "probe-test-key", checkVision });
const allPass = { chat: () => text("OK"), tools: () => call(), forced: () => call(), vision: () => text("Red.") };

await check("a working OpenAI-compatible model passes every step", async () => {
    const sent: Sent[] = [];
    const result = await probeModel(target("kilo", "acme/model:free"), { fetchImpl: stub(allPass, sent) });
    assert.equal(result.status, "passed");
    assert.equal(result.retired, false);
    assert.equal(result.supportsTools, true);
    assert.equal(result.supportsSearch, true);
    assert.equal(result.supportsVision, true);
    assert.equal(typeof result.chatMs, "number");
    assert.deepEqual(sent.map((entry) => entry.step), ["chat", "tools", "forced", "vision"]);
    assert.equal(sent[0].url, "https://api.kilo.ai/api/gateway/chat/completions");
    assert.equal(sent[0].headers.Authorization, "Bearer probe-test-key");
    assert.equal(sent[0].body.stream, true);
    assert.deepEqual(sent[0].body.reasoning, { enabled: false });
    assert.deepEqual(sent[2].body.tool_choice, { type: "function", function: { name: "probe_echo" } });
    const image = (sent[3].body.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0].content[1];
    assert.ok(image.image_url?.url.startsWith("data:image/png;base64,"));
});

await check("a timed-out chat is inconclusive and stops the probe", async () => {
    const sent: Sent[] = [];
    const result = await probeModel(target("nvidia-nim", "acme/slow"), { fetchImpl: stub({ chat: () => "hang" }, sent), timeouts: { chat: 30 } });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.steps.chat.outcome, "transient");
    assert.equal(result.steps.chat.detail, "Timed out.");
    assert.equal(result.steps.tools.outcome, "skipped");
    assert.equal(sent.length, 1);
    assert.equal(result.supportsTools, null);
});

await check("HTTP 410 fails the probe and marks the model retired; 404 only fails it", async () => {
    const gone = await probeModel(target("nvidia-nim", "acme/gone"), { fetchImpl: stub({ chat: () => json(410, { detail: "This model has reached its end of life." }) }) });
    assert.equal(gone.status, "failed");
    assert.equal(gone.retired, true);
    assert.equal(gone.steps.chat.detail, "This model has reached its end of life.");
    const missing = await probeModel(target("nvidia-nim", "acme/missing"), { fetchImpl: stub({ chat: () => json(404, { error: { message: "Not found" } }) }) });
    assert.equal(missing.status, "failed");
    assert.equal(missing.retired, false);
});

await check("a forced tool answered as plain JSON keeps tools but not Search", async () => {
    const result = await probeModel(target("nvidia-nim", "deepseek-ai/deepseek-v4.1-flash"), {
        fetchImpl: stub({ ...allPass, forced: () => text("{\"text\": \"zuychin\"}") }),
    });
    assert.equal(result.status, "passed");
    assert.equal(result.supportsTools, true);
    assert.equal(result.supportsSearch, false);
    assert.equal(result.steps.forced.detail, "Answered in text instead of calling the tool.");
});

await check("the wrong colour means no vision", async () => {
    const result = await probeModel(target("nvidia-nim", "acme/blind"), { fetchImpl: stub({ ...allPass, vision: () => text("Blue.") }) });
    assert.equal(result.status, "passed");
    assert.equal(result.supportsVision, false);
});

await check("a tool request refused with 400 means no tools and no Search, not a failed probe", async () => {
    const sent: Sent[] = [];
    const result = await probeModel(target("nvidia-nim", "acme/plain"), { fetchImpl: stub({ ...allPass, tools: () => json(400, { error: { message: "tools not supported" } }) }, sent) });
    assert.equal(result.status, "passed");
    assert.equal(result.supportsTools, false);
    assert.equal(result.supportsSearch, false);
    assert.equal(result.steps.forced.outcome, "skipped");
    assert.deepEqual(sent.map((entry) => entry.step), ["chat", "tools", "vision"]);
});

await check("a rate-limited tool step is inconclusive", async () => {
    const result = await probeModel(target("openrouter", "acme/busy:free"), { fetchImpl: stub({ ...allPass, tools: () => json(429, { error: { message: "Rate limit exceeded" } }) }) });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.supportsTools, null);
    assert.equal(result.steps.tools.httpStatus, 429);
});

await check("an error frame inside a 200 stream is classified by its code", async () => {
    const result = await probeModel(target("openrouter", "acme/flaky:free"), {
        fetchImpl: stub({ chat: () => sse([{ error: { code: 503, message: "Provider returned error" } }]) }),
    });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.steps.chat.httpStatus, 503);
    assert.equal(result.steps.chat.detail, "Provider returned error");
});

await check("reasoning without visible text still proves the chat works", async () => {
    const result = await probeModel(target("nvidia-nim", "acme/thinker", false), { fetchImpl: stub({ ...allPass, chat: reasoningOnly }) });
    assert.equal(result.steps.chat.outcome, "pass");
    assert.equal(result.status, "passed");
});

await check("Gemini uses its own endpoint, key header and function calling modes", async () => {
    const sent: Sent[] = [];
    const result = await probeModel(target("gemini-free", "gemini-3.5-flash-lite"), {
        fetchImpl: stub({ chat: () => geminiText("OK"), tools: geminiCall, forced: geminiCall, vision: () => geminiText("Red") }, sent),
    });
    assert.equal(result.status, "passed");
    assert.equal(result.supportsTools, true);
    assert.equal(result.supportsSearch, true);
    assert.equal(result.supportsVision, true);
    assert.equal(sent[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse");
    assert.equal(sent[0].headers["x-goog-api-key"], "probe-test-key");
    assert.equal(sent[0].headers.Authorization, undefined);
    assert.deepEqual((sent[2].body.toolConfig as Record<string, unknown>).functionCallingConfig, { mode: "ANY", allowedFunctionNames: ["probe_echo"] });
    const parts = (sent[3].body.contents as { parts: { inlineData?: { mimeType: string } }[] }[])[0].parts;
    assert.equal(parts[1].inlineData?.mimeType, "image/png");
});

await check("Gemini judges the colour from the visible answer, not the thought text", async () => {
    const result = await probeModel(target("gemini-free", "gemini-3.5-flash-lite"), {
        fetchImpl: stub({ chat: () => geminiText("OK"), tools: geminiCall, forced: geminiCall, vision: () => geminiText("Blue") }),
    });
    assert.equal(result.supportsVision, false);
});

await check("vision is skipped when the list rules out image input", async () => {
    const sent: Sent[] = [];
    const result = await probeModel(target("openrouter", "acme/text-only:free", false), { fetchImpl: stub(allPass, sent) });
    assert.equal(result.supportsVision, null);
    assert.equal(result.steps.vision.outcome, "skipped");
    assert.ok(!sent.some((entry) => entry.step === "vision"));
});

await check("probe calls are recorded as model health with the probe purpose", async () => {
    const passed = await collectModelObservations(() => probeModel(target("nvidia-nim", "acme/observed"), { fetchImpl: stub(allPass) }));
    assert.deepEqual(passed.observations.map((entry) => entry.purpose), ["probe", "probe", "probe", "probe"]);
    assert.ok(passed.observations.every((entry) => entry.status === "success" && entry.capabilities.streaming));
    assert.equal(passed.observations[1].capabilities.tools, true);
    assert.equal(passed.observations[3].capabilities.vision, true);
    assert.notEqual(passed.observations[0].firstAnswerMs, null);
    const gone = await collectModelObservations(() => probeModel(target("nvidia-nim", "acme/gone"), { fetchImpl: stub({ chat: () => json(410, {}) }) }));
    assert.equal(gone.observations[0].status, "retired");
    assert.equal(gone.observations[0].httpStatus, 410);
});

await check("the probe image is a valid solid-colour PNG", async () => {
    const png = solidPng(4, 3, [220, 38, 38]);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 4);
    assert.equal(png.readUInt32BE(20), 3);
    const idatLength = png.readUInt32BE(33);
    assert.equal(png.toString("ascii", 37, 41), "IDAT");
    const pixels = inflateSync(png.subarray(41, 41 + idatLength));
    assert.equal(pixels.length, 3 * (1 + 4 * 3));
    assert.deepEqual([...pixels.subarray(1, 4)], [220, 38, 38]);
    const zlib = await import("node:zlib");
    if ("crc32" in zlib) assert.equal(png.readUInt32BE(29), (zlib as unknown as { crc32: (data: Uint8Array) => number }).crc32(png.subarray(12, 29)));
});

console.log(`${checks} catalogue probe checks passed`);
