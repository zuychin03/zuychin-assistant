// Offline checks for the V8 media kinds: listings, request adapters, probes, resolution, data policy and the build page
// retirement rule. Every request goes to a fake fetch; no live services.
import assert from "node:assert/strict";
import { isMediaKind, mediaKindsEnabled, parseGeminiModels, parseOpenAiModelList, parseOpenRouterModels, selectAllDiscoverable, type ProviderDiscovery } from "../src/lib/ai/catalogue/sources";
import { mediaPost, mediaRouteSupported, renderTranslatePrompt, requestDecision, requestImage, requestRerank } from "../src/lib/ai/media/requests";
import { probeRerank, RERANK_PROBE_PASSAGES } from "../src/lib/ai/catalogue/probe-rerank";
import { probePage, probePageMissing, probeParse } from "../src/lib/ai/catalogue/probe-parse";
import { probeImage } from "../src/lib/ai/catalogue/probe-image";
import { probeDecision } from "../src/lib/ai/catalogue/probe-decision";
import { probeLive } from "../src/lib/ai/catalogue/probe-live";
import { probeTranslate, translationProblem, TRANSLATE_PROBES } from "../src/lib/ai/catalogue/probe-translate";
import { probeTypedModel } from "../src/lib/ai/catalogue/probe-typed";
import { parseOutputToMarkdown, tabularToMarkdown } from "../src/lib/capture/extract/parse-markdown";
import { mediaInUse, pickMediaRow } from "../src/lib/ai/media/resolve";
import { parseMediaChoices } from "../src/lib/ai/media/choices";
import { inUseRoutes } from "../src/lib/ai/catalogue/in-use";
import { setCatalogueSnapshotForTests, type CatalogueRow } from "../src/lib/ai/catalogue/snapshot";
import { assessDataRoute } from "../src/lib/ai/data-policy";
import { buildPageDate, lookupRetirement, nimBuildPageUrl } from "../src/lib/ai/models/retirement-lookup";
import { traitsFromDb } from "../src/lib/ai/catalogue/rows";
import type { LiveClient } from "../src/lib/ai/media/live";

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const nim = { id: "nvidia-nim", kind: "openai-compatible" as const, baseUrl: "https://nim.invalid/v1" };
const gemini = { id: "gemini-free", kind: "gemini" as const };
const openrouter = { id: "openrouter", kind: "openai-compatible" as const, baseUrl: "https://openrouter.invalid/api/v1" };
const route = (provider: typeof nim | typeof gemini | typeof openrouter, modelId: string) => ({ provider, modelId, apiKey: "fixture-key" });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
type Call = { url: string; init?: RequestInit };
function fake(reply: (call: Call, index: number) => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const call = { url: String(input), init };
        calls.push(call);
        return reply(call, calls.length - 1);
    }) as typeof fetch;
}
const gone = () => json(410, { type: "about:blank", title: "Gone", status: 410, detail: "This endpoint has reached its end of life on 2026-08-25T09:00:00Z and is no longer available." });

// The live parse reply for the probe page on 24/11/2026, blocks out of reading order as the model sent them.
const PARSE_REPLY = "<x_0.04><y_0.0461>**Week 3 Study Notes: Retrieval**<x_0.6016><y_0.1023><class_Section-header>\n\n<x_0.0391><y_0.1578>Reranking reorders search results by relevance to the query. Embeddings find candidates; a reranker picks the best few.<x_0.71><y_0.25><class_Text>\n\n<x_0.0381><y_0.7141>Due date: 28/11/2026. Ask the tutor about chunk sizes.<x_0.6475><y_0.7539><class_Text>\n\n<x_0.0371><y_0.3109>\\begin{tabular}{ccc}\n\\thead{Model} & \\thead{Type} & \\thead{Latency}\\\\\nRerank 8B & Reranker & 0.4 s\\\\\nEmbed 1B & Embedding & 0.3 s\\\\\nParse & OCR & 2.0 s\\\\\n\\end{tabular}<x_0.8799><y_0.657><class_Table>";

await check("listings: OpenRouter rerank and image outputs, Gemini decision and live, NIM translate ids become media kinds", () => {
    const or = parseOpenRouterModels({ data: [
        { id: "cohere/rerank-5:free", name: "Rerank 5 (free)", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["rerank"] } },
        { id: "black-forest-labs/flux-x:free", name: "Flux X", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] } },
    ] });
    assert.deepEqual(or.map((model) => model.kind), ["rerank", "image"]);
    const gem = parseGeminiModels({ models: [
        { name: "models/gemini-decision-1", supportedGenerationMethods: ["createDecision"] },
        { name: "models/gemini-3.8-live", supportedGenerationMethods: ["bidiGenerateContent"] },
        { name: "models/gemini-3.8-live-translate", supportedGenerationMethods: ["bidiGenerateContent"] },
        { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
    ] }, true);
    assert.deepEqual(gem.map((model) => model.kind), ["decision", "live", null, "chat"]);
    const list = parseOpenAiModelList({ data: [{ id: "nvidia/riva-translate-4b-instruct-v2" }, { id: "acme/nmt-small" }, { id: "nvidia/nemotron-3-ultra-550b-a55b" }] }, true);
    assert.deepEqual(list.map((model) => [model.kind, model.chat]), [["translate", false], ["translate", false], ["chat", true]]);
    const discovery: ProviderDiscovery = { source: "openai-list", include: "all", pricing: "all-free", kinds: { translate: { include: "all" } } };
    assert.deepEqual(selectAllDiscoverable(list, discovery).map((model) => model.modelId), ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/riva-translate-4b-instruct-v2", "acme/nmt-small"]);
    assert.deepEqual(selectAllDiscoverable(list, discovery, new Set(), ["chat", "embedding"]).map((model) => model.modelId), ["nvidia/nemotron-3-ultra-550b-a55b"], "media kinds left out until v8-media.sql");
    assert.equal(mediaKindsEnabled(undefined), true);
    assert.equal(mediaKindsEnabled(" OFF "), false);
    assert.ok(isMediaKind("live") && !isMediaKind("speech"));
});

await check("request shapes: which providers this app can call per kind", () => {
    assert.ok(mediaRouteSupported("rerank", nim) && mediaRouteSupported("parse", nim) && mediaRouteSupported("image", nim));
    assert.ok(!mediaRouteSupported("rerank", openrouter) && !mediaRouteSupported("image", openrouter));
    assert.ok(mediaRouteSupported("decision", gemini) && mediaRouteSupported("live", { id: "gemini", kind: "gemini" }) && !mediaRouteSupported("decision", nim));
    assert.ok(mediaRouteSupported("translate", nim) && !mediaRouteSupported("translate", gemini));
});

await check("rerank: request shape, pass, wrong order, 404, 410 date and a short reply", async () => {
    const calls: Call[] = [];
    const ranked = (order: number[]) => json(200, { rankings: order.map((index, rank) => ({ index, logit: 1 - rank })) });
    const pass = await probeRerank(route(nim, "nvidia/nemotron-3.5-rerank-8b"), { fetchImpl: fake(() => ranked([2, 0, 3, 1]), calls) });
    assert.equal(pass.status, "passed");
    assert.equal(calls[0].url, "https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-rerank-8b/reranking");
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.model, "nvidia/nemotron-3.5-rerank-8b");
    assert.equal(body.passages.length, RERANK_PROBE_PASSAGES.length);
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer fixture-key");
    assert.equal((await probeRerank(route(nim, "x/r"), { fetchImpl: fake(() => ranked([0, 1, 2, 3])) })).status, "failed");
    const missing = await probeRerank(route(nim, "x/r"), { fetchImpl: fake(() => json(404, { detail: "Function not found" })) });
    assert.equal(missing.status, "failed");
    assert.match(missing.steps.rerank.detail ?? "", /Not callable on this key/);
    const retired = await probeRerank(route(nim, "x/r"), { fetchImpl: fake(gone) });
    assert.deepEqual([retired.status, retired.retired, retired.retiredAt], ["failed", true, "2026-08-25T09:00:00.000Z"]);
    const short = await requestRerank(route(nim, "x/r"), "q", ["a", "b"], { timeoutMs: 1000, fetchImpl: fake(() => json(200, { rankings: [{ index: 0, logit: 1 }, { index: 0, logit: 0 }] })) });
    assert.equal(short.ok, false);
    const busy = await probeRerank(route(nim, "x/r"), { fetchImpl: fake(() => json(429, { detail: "Too many requests" })) });
    assert.equal(busy.status, "inconclusive");
});

await check("NVCF: a 202 is polled on the status URL until it answers; a timeout is transient", async () => {
    const calls: Call[] = [];
    const result = await requestImage(route(nim, "black-forest-labs/flux.2-klein-4b"), { prompt: "p", width: 768, height: 768 }, {
        timeoutMs: 5000, pollMs: 0,
        fetchImpl: fake((_call, index) => index < 2 ? new Response(null, { status: 202, headers: { "NVCF-REQID": "req-1" } })
            : json(200, { artifacts: [{ base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(3000).fill(1)]).toString("base64"), finishReason: "SUCCESS" }] }), calls),
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { prompt: "p", width: 768, height: 768 }, "no seed: FLUX.2 klein refuses it");
    assert.equal(calls[1].url, "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/req-1");
    assert.equal(calls.length, 3);
    const hanging = fake((call) => new Promise<Response>((_resolve, reject) => call.init?.signal?.addEventListener("abort", () => reject(call.init!.signal!.reason))));
    // AbortSignal.timeout does not hold the event loop open on its own.
    const keepAlive = setInterval(() => {}, 1000);
    const timedOut = await mediaPost("https://nim.invalid/slow", "{}", {}, { timeoutMs: 30, fetchImpl: hanging }).finally(() => clearInterval(keepAlive));
    assert.ok(!timedOut.ok && timedOut.timedOut && timedOut.transient && timedOut.status === null);
});

await check("image: pass with JPEG bytes, fail on no artifact, a filtered image or a 422", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(4000).fill(7)]).toString("base64");
    const pass = await probeImage(route(nim, "black-forest-labs/flux.2-klein-4b"), { fetchImpl: fake(() => json(200, { artifacts: [{ base64: jpeg, finishReason: "SUCCESS" }] })) });
    assert.equal(pass.status, "passed");
    assert.deepEqual(pass.traits, { sizes: ["768x768"] });
    assert.equal((await probeImage(route(nim, "x/i"), { fetchImpl: fake(() => json(200, { artifacts: [] })) })).status, "failed");
    assert.equal((await probeImage(route(nim, "x/i"), { fetchImpl: fake(() => json(200, { artifacts: [{ base64: jpeg, finishReason: "CONTENT_FILTERED" }] })) })).status, "failed");
    const refused = await probeImage(route(nim, "x/i"), { fetchImpl: fake(() => json(422, { detail: [{ type: "extra_forbidden", loc: ["body", "seed"] }] })) });
    assert.equal(refused.status, "failed");
    assert.match(refused.steps.image.detail ?? "", /extra_forbidden/);
});

await check("parse: the converter turns tags and LaTeX tables into Markdown in reading order", () => {
    const markdown = parseOutputToMarkdown(PARSE_REPLY);
    assert.equal(markdown.split("\n")[0], "## Week 3 Study Notes: Retrieval");
    assert.ok(markdown.indexOf("| Rerank 8B | Reranker | 0.4 s |") < markdown.indexOf("Due date: 28/11/2026"), "the table sits above the due date");
    assert.match(markdown, /\| Model \| Type \| Latency \|\n\| --- \| --- \| --- \|/);
    assert.deepEqual(probePageMissing(markdown), []);
    assert.equal(tabularToMarkdown("\\begin{tabular}{cc}\\hline \\multicolumn{2}{c}{Both} \\\\ a \\& b & 50\\% \\\\ \\end{tabular}"), "| Both |   |\n| --- | --- |\n| a & b | 50% |");
    assert.equal(tabularToMarkdown("\\begin{tabular}{c}\\end{tabular}"), null);
    assert.equal(parseOutputToMarkdown("plain text with <x_0.1> stray tags"), "plain text with  stray tags");
    assert.equal(parseOutputToMarkdown("<x_0.1><y_0.9>Page 3<x_0.2><y_0.95><class_Page-footer>"), "");
    assert.equal(parseOutputToMarkdown("<x_0.1><y_0.1>one<x_0.2><y_0.15><class_List-item><x_0.1><y_0.2>- two<x_0.2><y_0.25><class_List-item>"), "- one\n- two");
});

await check("parse: multipart request with the probe page; pass, missing facts and a 404", async () => {
    const calls: Call[] = [];
    const pass = await probeParse(route(nim, "nvidia/nemotron-3.5-parse"), { fetchImpl: fake(() => json(200, { content: PARSE_REPLY }), calls) });
    assert.equal(pass.status, "passed");
    assert.equal(pass.traits.outputTokens, 2048);
    assert.equal(calls[0].url, "https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-parse/parse");
    const form = calls[0].init?.body as FormData;
    assert.ok(form instanceof FormData);
    const page = form.get("document") as File;
    assert.equal(page.type, "image/png");
    assert.equal(page.size, probePage().length);
    assert.deepEqual(JSON.parse(await (form.get("options") as Blob).text()), { decoding: { max_output_tokens: 2048 } });
    assert.equal([...probePage().subarray(0, 4)].join(","), "137,80,78,71", "a PNG");
    const partial = await probeParse(route(nim, "x/p"), { fetchImpl: fake(() => json(200, { content: "<x_0.1><y_0.1>Week 3 Study Notes: Retrieval<x_0.2><y_0.2><class_Title>" })) });
    assert.equal(partial.status, "failed");
    assert.match(partial.steps.parse.detail ?? "", /table row, due date/);
    assert.equal((await probeParse(route(nim, "x/p"), { fetchImpl: fake(() => json(404, { detail: "no" })) })).status, "failed");
});

await check("decision: REST shape, pass, a wrong answer, a missing answer and a 410", async () => {
    const calls: Call[] = [];
    const answers = (topic: string, noul = 0.93, score = 1.8) => json(200, { answers: {
        appointment: { type: "noul", noul, confidence: noul, probabilities: {} },
        topic: { type: "choice", choice: topic, confidence: 0.9, probabilities: { health: 0.9, cooking: 0.05, sport: 0.05 } },
        urgency: { type: "score", score, confidence: 0.7, probabilities: {} },
    } });
    const pass = await probeDecision(route(gemini, "gemini-decision-1"), { fetchImpl: fake(() => answers("health"), calls) });
    assert.equal(pass.status, "passed");
    assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/decisions");
    assert.equal((calls[0].init?.headers as Record<string, string>)["x-goog-api-key"], "fixture-key");
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.model, "gemini-decision-1");
    assert.deepEqual(Object.keys(body.questions), ["appointment", "topic", "urgency"]);
    const wrong = await probeDecision(route(gemini, "gemini-decision-1"), { fetchImpl: fake(() => answers("sport", 0.2, 0.1)) });
    assert.equal(wrong.status, "failed");
    assert.match(wrong.steps.decision.detail ?? "", /Wrong yes\/no, choice, score/);
    const partial = await requestDecision(route(gemini, "gemini-decision-1"), "x", { a: { type: "noul", instructions: "?" } }, { timeoutMs: 1000, fetchImpl: fake(() => json(200, { answers: {} })) });
    assert.equal(partial.ok, false);
    const unknown = await requestDecision(route(gemini, "gemini-decision-1"), "x", { a: { type: "choice", instructions: "?", criteria: { yes: "y" } } }, { timeoutMs: 1000, fetchImpl: fake(() => json(200, { answers: { a: { choice: "maybe" } } })) });
    assert.equal(unknown.ok, false, "a choice outside the criteria is refused");
    assert.equal((await probeDecision(route(gemini, "gemini-decision-1"), { fetchImpl: fake(gone) })).retired, true);
});

await check("live: token then one text turn; audio and a transcript pass, the rest fail or retry", async () => {
    const client = (turn: Partial<Awaited<ReturnType<LiveClient["textTurn"]>>> | Error, token: "ok" | 403 = "ok"): LiveClient => ({
        createToken: async () => token === "ok" ? { ok: true, token: "auth_tokens/fixture", ms: 300 }
            : { ok: false, status: 403, ms: 200, error: "API key not valid", transient: false, timedOut: false, retiredAt: null },
        textTurn: async (tokenName, modelId, text, timeoutMs) => {
            assert.equal(tokenName, "auth_tokens/fixture");
            assert.equal(modelId, "gemini-3.8-live");
            assert.match(text, /good morning/);
            assert.equal(timeoutMs, 15_000);
            if (turn instanceof Error) throw turn;
            return { outcome: "complete", firstAudioMs: 3900, audioBytes: 125_280, transcript: "Good morning, the probe works.", closeReason: null, ...turn };
        },
    });
    const live = route(gemini, "gemini-3.8-live");
    const pass = await probeLive(live, client({}));
    assert.equal(pass.status, "passed");
    assert.equal(pass.ms, 3900);
    assert.deepEqual(pass.traits, { audioFormat: "pcm", sampleRate: 24000, channels: 1, audioSec: 2.6, firstAudioMs: 3900 });
    assert.equal((await probeLive(live, client({ audioBytes: 0 }))).status, "failed");
    assert.equal((await probeLive(live, client({ outcome: "timeout", firstAudioMs: null, audioBytes: 0, transcript: "" }))).status, "inconclusive");
    assert.equal((await probeLive(live, client(new Error("socket hang up")))).status, "inconclusive");
    const refused = await probeLive(live, client({}, 403));
    assert.equal(refused.status, "failed");
    assert.equal(refused.steps.token.httpStatus, 403);
});

await check("translate: the right language, every number and the day must survive", () => {
    const [vi, fr] = TRANSLATE_PROBES;
    assert.equal(translationProblem(vi, "Buổi hướng dẫn đã chuyển sang thứ Năm lúc 15:30 tại phòng 204 vào ngày 28/11/2026."), null);
    assert.equal(translationProblem(fr, "La réunion est lundi à 9 h 15 dans la salle 12B, avant le 01/12/2026."), null);
    assert.match(translationProblem(vi, "Tutorialen flyttas till torsdag kl. 15.30 i lokal 204 den 28/11/2026.") ?? "", /Not Vietnamese/, "Swedish is the wrong language");
    assert.match(translationProblem(vi, "Buổi hướng dẫn đã chuyển sang thứ Năm lúc 15:30 tại phòng 205 vào ngày 28/11/2026.") ?? "", /Changed or lost 204/);
    assert.match(translationProblem(vi, "Buổi hướng dẫn đã chuyển sang thứ Tư lúc 15:30 tại phòng 204 vào ngày 28/11/2026.") ?? "", /day/, "Thursday became Wednesday");
    assert.match(translationProblem(fr, "Mötet är på måndag 09:15 i rum 12B, före 01/12/2026.") ?? "", /Not French/);
    assert.equal(renderTranslatePrompt("Translate the following text from {source} to {target}:\n{text}", { text: "Hi", source: "English", target: "French" }), "Translate the following text from English to French:\nHi");
    assert.equal(renderTranslatePrompt("Into {target}.", { text: "Hi", source: "English", target: "French" }), "Into French.\nHi");
});

await check("translate: the stored template is the one sent; a pass keeps it, a 410 retires", async () => {
    const calls: Call[] = [];
    const good: Record<string, string> = {
        Vietnamese: "Buổi hướng dẫn đã chuyển sang thứ Năm lúc 15:30 tại phòng 204 vào ngày 28/11/2026.",
        French: "La réunion est lundi à 09:15 dans la salle 12B, avant le 01/12/2026.",
    };
    const reply = (call: Call) => {
        const content = JSON.parse(String(call.init?.body)).messages[0].content as string;
        const target = /to (\w+):/.exec(content)![1];
        return json(200, { choices: [{ message: { content: good[target] } }] });
    };
    const template = "Translate the following text from {source} to {target}:\n{text}";
    const pass = await probeTranslate(route(nim, "nvidia/riva-translate-4b-instruct-v2"), template, { fetchImpl: fake(reply, calls) });
    assert.equal(pass.status, "passed");
    assert.equal(pass.traits.promptTemplate, template);
    assert.equal(calls[0].url, "https://nim.invalid/v1/chat/completions");
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(sent.messages.map((message: { role: string }) => message.role), ["user"], "no system prompt: it produced the wrong language on 24/11");
    assert.match(sent.messages[0].content, /^Translate the following text from English to Vietnamese:\nThe tutorial/);
    const wrong = await probeTranslate(route(nim, "x/t"), template, { fetchImpl: fake(() => json(200, { choices: [{ message: { content: "Tutorialen flyttas till torsdag." } }] })) });
    assert.equal(wrong.status, "failed");
    assert.deepEqual(wrong.traits, {});
    const retired = await probeTranslate(route(nim, "x/t"), template, { fetchImpl: fake(gone) });
    assert.deepEqual([retired.status, retired.retired], ["failed", true]);
    const slow = await probeTranslate(route(nim, "x/t"), template, { fetchImpl: fake(() => json(503, { detail: "busy" })) });
    assert.equal(slow.status, "inconclusive");
});

await check("dispatch: media kinds go to their probe; a provider without a request shape fails without a call", async () => {
    const calls: Call[] = [];
    const result = await probeTypedModel({ kind: "rerank", provider: openrouter, modelId: "cohere/rerank-5:free", apiKey: "k" }, { fetchImpl: fake(() => json(200, {}), calls) });
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 0);
    assert.match(result.steps.rerank.detail ?? "", /no rerank request for openrouter/);
    const decision = await probeTypedModel({ kind: "decision", provider: gemini, modelId: "gemini-decision-1", apiKey: "k" }, { fetchImpl: fake(() => json(200, { answers: {} })) });
    assert.equal(decision.dimension, null);
    assert.equal(decision.status, "failed");
});

const DAY = 24 * 60 * 60_000;
const at = (offsetDays: number) => new Date(Date.parse("2026-11-24T00:00:00.000Z") + offsetDays * DAY).toISOString();
function row(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId" | "kind">): CatalogueRow {
    return {
        origin: "seed", label: overrides.modelId, shortName: overrides.modelId.replace(/\//g, "-"), description: null, developer: null, free: true, metered: false, mayTrain: null,
        contextTokens: null, maxOutputTokens: null, inputs: [], listedTools: null, listedStructured: null, listedThinking: null,
        probeStatus: "passed", probeAttempts: 0, probedAt: at(-1), probeChatMs: 600, supportsTools: null, supportsSearch: null, supportsVision: null,
        supportsThinking: null, supportsStructured: null, firstSeenAt: at(-5), lastSeenAt: at(-1), missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: at(-5), dimension: null, expiresAt: null, expiresSource: null, notifiedExpiryDays: null, expiryCheckedAt: null, spaceOf: null, traits: {},
        ...overrides,
    };
}

await check("resolution: by kind, Free only, paid-first decisions, the owner's choice and what is not usable", () => {
    const rows = [
        row({ providerId: "gemini", modelId: "gemini-decision-1", kind: "decision", free: false, label: "B paid" }),
        row({ providerId: "gemini-free", modelId: "gemini-decision-1", kind: "decision", label: "A free" }),
        row({ providerId: "nvidia-nim", modelId: "nvidia/rerank-a", kind: "rerank", label: "A" }),
        row({ providerId: "nvidia-nim", modelId: "nvidia/rerank-b", kind: "rerank", label: "B" }),
        row({ providerId: "nvidia-nim", modelId: "nvidia/rerank-unapproved", kind: "rerank", approvedAt: null, label: "0" }),
        row({ providerId: "nvidia-nim", modelId: "nvidia/rerank-failing", kind: "rerank", probeStatus: "failed", label: "0" }),
        row({ providerId: "nvidia-nim", modelId: "nvidia/rerank-gone", kind: "rerank", expiresSource: "gone", label: "0" }),
        row({ providerId: "nvidia-nim", modelId: "nvidia/rerank-missing", kind: "rerank", missingSince: at(-1), label: "0" }),
        row({ providerId: "nvidia-nim", modelId: "nvidia/riva", kind: "translate", traits: { languages: ["fr"] } }),
    ];
    const routable = () => true;
    const pick = (kind: Parameters<typeof pickMediaRow>[0], freeOnly: boolean, extra: Partial<Parameters<typeof pickMediaRow>[2]> = {}) =>
        pickMediaRow(kind, rows, { freeOnly, routable, ...extra })?.providerId + "::" + pickMediaRow(kind, rows, { freeOnly, routable, ...extra })?.modelId;
    assert.equal(pick("decision", false), "gemini::gemini-decision-1", "normal mode keeps decisions on the paid key");
    assert.equal(pick("decision", true), "gemini-free::gemini-decision-1");
    assert.equal(pick("rerank", false), "nvidia-nim::nvidia/rerank-a");
    assert.equal(pick("rerank", false, { choice: { providerId: "nvidia-nim", modelId: "nvidia/rerank-b" } }), "nvidia-nim::nvidia/rerank-b");
    assert.equal(pick("rerank", false, { choice: { providerId: "nvidia-nim", modelId: "nvidia/rerank-failing" } }), "nvidia-nim::nvidia/rerank-a", "a broken choice falls back");
    assert.equal(pick("rerank", false, { removed: new Set(["nvidia-nim::nvidia/rerank-a"]) }), "nvidia-nim::nvidia/rerank-b");
    assert.equal(pickMediaRow("rerank", rows, { freeOnly: false, routable: (entry) => entry.modelId !== "nvidia/rerank-a" && entry.modelId !== "nvidia/rerank-b" }), null);
    assert.equal(pickMediaRow("translate", rows, { freeOnly: true, routable, filter: (entry) => entry.traits?.languages?.includes("vi") ?? false }), null);
    assert.equal(pickMediaRow("image", rows, { freeOnly: false, routable }), null);
    const picks = mediaInUse(rows, {}, new Set(), routable, ["decision", "live"]);
    assert.equal(picks.decision?.normal?.providerId, "gemini");
    assert.equal(picks.decision?.freeOnly?.providerId, "gemini-free");
    assert.deepEqual(picks.live, { normal: null, freeOnly: null });
    const inUse = inUseRoutes({ embedding: null, speech: { providerId: "gemini", modelId: "tts", voice: null }, transcription: { order: "local", providerId: null, modelId: null }, media: [picks.decision!.normal!, picks.decision!.freeOnly!] }, rows);
    assert.ok(inUse.keys.has("gemini::gemini-decision-1") && inUse.keys.has("gemini-free::gemini-decision-1"));
    assert.deepEqual(parseMediaChoices({ rerank: { providerId: "nvidia-nim", modelId: "nvidia/rerank-a" }, image: { providerId: "bad id" }, nonsense: {} }), { rerank: { providerId: "nvidia-nim", modelId: "nvidia/rerank-a" } });
});

await check("data policy: rerank and decision follow the embedding rule when unattended; image does not", () => {
    setCatalogueSnapshotForTests([
        row({ providerId: "nvidia-nim", modelId: "nvidia/nemotron-3.5-rerank-8b", kind: "rerank" }),
        row({ providerId: "gemini-free", modelId: "gemini-decision-1", kind: "decision" }),
        row({ providerId: "nvidia-nim", modelId: "black-forest-labs/flux.2-klein-4b", kind: "image" }),
    ]);
    const rerank = assessDataRoute({ providerId: "nvidia-nim", modelId: "nvidia/nemotron-3.5-rerank-8b", purpose: "rerank", classes: ["unattended"] });
    assert.deepEqual([rerank.tier, rerank.allowed, rerank.rule], ["free", true, "unattended_scoring"]);
    const decision = assessDataRoute({ providerId: "gemini-free", modelId: "gemini-decision-1", purpose: "decision", classes: ["unattended", "personal"] });
    assert.deepEqual([decision.allowed, decision.rule], [true, "unattended_scoring"]);
    const image = assessDataRoute({ providerId: "nvidia-nim", modelId: "black-forest-labs/flux.2-klein-4b", purpose: "image", classes: ["unattended"] });
    assert.deepEqual([image.allowed, image.rule], [false, "scheduled_generation"]);
    const interactive = assessDataRoute({ providerId: "nvidia-nim", modelId: "black-forest-labs/flux.2-klein-4b", purpose: "image", classes: ["personal"], freeOnly: true });
    assert.deepEqual([interactive.allowed, interactive.rule], [true, "interactive"]);
    setCatalogueSnapshotForTests([]);
});

await check("rows: media traits are read back and junk is dropped", () => {
    assert.deepEqual(traitsFromDb({ sizes: ["768x768", 3], languages: ["vi", "fr"], promptTemplate: "T {text}", maxPairTokens: 8192, outputTokens: 2048, editing: false, imagePassages: "yes" }),
        { sizes: ["768x768"], languages: ["vi", "fr"], promptTemplate: "T {text}", maxPairTokens: 8192, outputTokens: 2048, editing: false });
});

await check("retirement: NIM build page date first, the search only when the page cannot be read", async () => {
    assert.equal(nimBuildPageUrl("nvidia/nemotron-3.5-embed-1b"), "https://build.nvidia.com/nvidia/nemotron-3_5-embed-1b");
    assert.equal(nimBuildPageUrl("black-forest-labs/flux.2-klein-4b"), "https://build.nvidia.com/black-forest-labs/flux_2-klein-4b");
    assert.equal(nimBuildPageUrl("no-publisher"), null);
    const deprecated = `<div>{\\"key\\":\\"DEPRECATION\\",\\"value\\":\\"11/22/2026\\"}</div>`;
    assert.equal(buildPageDate(deprecated), "2026-11-22T00:00:00.000Z");
    assert.equal(buildPageDate("This API will be deprecated on 08/25/2026. It will no longer be supported."), "2026-08-25T00:00:00.000Z");
    assert.equal(buildPageDate("This API will be deprecated on 13/45/2026."), null);
    assert.equal(buildPageDate("<html>Free Endpoint</html>"), null);
    const searches: string[] = [];
    const deps = (page: string | null) => ({
        page: async () => page,
        search: async (query: string) => { searches.push(query); return []; },
        ask: async () => null,
    });
    const target = { providerId: "nvidia-nim", providerLabel: "NVIDIA NIM", modelId: "nvidia/nemotron-3.5-parse", label: "Parse" };
    assert.deepEqual(await lookupRetirement(target, deps(deprecated)), { ok: true, date: "2026-11-22T00:00:00.000Z", url: "https://build.nvidia.com/nvidia/nemotron-3_5-parse" });
    assert.deepEqual(await lookupRetirement(target, deps("<html>Free Endpoint</html>")), { ok: true, date: null, url: null });
    assert.equal(searches.length, 0);
    await lookupRetirement(target, deps(null));
    assert.equal(searches.length, 1, "an unreadable page falls back to the search");
    await lookupRetirement({ ...target, providerId: "groq" }, deps(deprecated));
    assert.equal(searches.length, 2, "other providers never read a build page");
});

console.log(`${checks} media kind checks passed`);
