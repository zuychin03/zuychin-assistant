// Offline checks for API speech to text: each order, each adapter's request shape, Free only and approval rules,
// fallbacks between the box and the API, Telegram voice notes piece by piece, and observations without text.
import assert from "node:assert/strict";
Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://stt-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_FREE_API_KEY: "fixture-free", OPENROUTER_API_KEY: "fixture-or", GROQ_API_KEY: "fixture-groq",
});

const { transcribeWithApi, wordAccuracy } = await import("../src/lib/voice/api-stt");
const { apiTranscriptionRoute, transcribeInOrder, transcriptionSteps } = await import("../src/lib/voice/transcribe-order");
const { transcribeVoiceNote } = await import("../src/lib/voice/voice-note");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { withModelObservationCollector } = await import("../src/lib/ai/model-observations");
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;
type ApiSttRoute = import("../src/lib/voice/api-stt").ApiSttRoute;
type ApiSttResult = import("../src/lib/voice/api-stt").ApiSttResult;
type SttResult = import("../src/lib/voice/stt-client").SttResult;
type TranscriptionChoice = import("../src/lib/ai/voice-choices").TranscriptionChoice;

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

function sttRow(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.replace(/^.*\//, ""), description: null, developer: null,
        free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: ["audio"],
        listedTools: null, listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 900,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null,
        firstSeenAt: "2026-11-24T00:00:00.000Z", lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: "2026-11-24T00:00:00.000Z", kind: "transcription", traits: { accuracy: 1 },
        ...overrides,
    };
}
setCatalogueSnapshotForTests([
    sttRow({ providerId: "groq", modelId: "whisper-large-v3-turbo" }),
    sttRow({ providerId: "openrouter", modelId: "vendor/paid-ears", free: false }),
    sttRow({ providerId: "openrouter", modelId: "vendor/new-ears:free", approvedAt: null, probeStatus: "untested" }),
    sttRow({ providerId: "openrouter", modelId: "vendor/broken-ears:free", probeStatus: "failed" }),
    sttRow({ providerId: "gemini-free", modelId: "gemini-3.5-transcribe" }),
]);
const choice = (order: TranscriptionChoice["order"], providerId = "groq", modelId = "whisper-large-v3-turbo"): TranscriptionChoice => ({ order, providerId, modelId });
const pcm = (bytes: number) => new Uint8Array(new ArrayBuffer(bytes));
const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.alloc(3200)]);

await check("each order gives its steps, and a step that is not ready drops out", () => {
    assert.deepEqual(transcriptionSteps("local", true, true), ["local"]);
    assert.deepEqual(transcriptionSteps("local-first", true, true), ["local", "api"]);
    assert.deepEqual(transcriptionSteps("api-first", true, true), ["api", "local"]);
    assert.deepEqual(transcriptionSteps("api", true, true), ["api"]);
    assert.deepEqual(transcriptionSteps("api-first", false, true), ["api"]);
    assert.deepEqual(transcriptionSteps("local-first", true, false), ["local"]);
    assert.deepEqual(transcriptionSteps("api", true, false), []);
});

await check("the API route needs an approved, passing, keyed model; Free only refuses a paid one", () => {
    assert.equal(apiTranscriptionRoute(choice("api"), true)?.modelId, "whisper-large-v3-turbo");
    assert.equal(apiTranscriptionRoute(choice("local"), false), null, "the local order never builds a route");
    assert.equal(apiTranscriptionRoute({ order: "api", providerId: null, modelId: null }, false), null);
    assert.equal(apiTranscriptionRoute(choice("api", "openrouter", "vendor/paid-ears"), true), null);
    assert.equal(apiTranscriptionRoute(choice("api", "openrouter", "vendor/paid-ears"), false)?.modelId, "vendor/paid-ears");
    assert.equal(apiTranscriptionRoute(choice("api", "openrouter", "vendor/new-ears:free"), false), null, "not approved");
    assert.equal(apiTranscriptionRoute(choice("api", "openrouter", "vendor/broken-ears:free"), false), null, "failing its test");
    assert.equal(apiTranscriptionRoute(choice("api", "openrouter", "vendor/unknown"), false), null);
    const key = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try { assert.equal(apiTranscriptionRoute(choice("api"), false), null, "no key, no route"); } finally { process.env.GROQ_API_KEY = key; }
});

await check("each adapter sends its own request shape", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} });
        return String(url).includes("googleapis") ? Response.json({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: " hello there " }] } }] }) : Response.json({ text: " hello there " });
    }) as typeof fetch;
    const groq = apiTranscriptionRoute(choice("api"), false)!;
    const router = apiTranscriptionRoute(choice("api", "openrouter", "vendor/paid-ears"), false)!;
    const gemini = apiTranscriptionRoute(choice("api", "gemini-free", "gemini-3.5-transcribe"), false)!;

    assert.deepEqual(await transcribeWithApi(groq, wav, { fetchImpl }).then((result) => result.ok && result.text), "hello there");
    const form = seen[0].init.body as FormData;
    assert.equal(seen[0].url, "https://api.groq.com/openai/v1/audio/transcriptions");
    assert.ok(form instanceof FormData);
    assert.deepEqual([form.get("model"), form.get("language"), form.get("response_format"), (form.get("file") as File).type], ["whisper-large-v3-turbo", "en", "json", "audio/wav"]);
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, "Bearer fixture-groq");

    await transcribeWithApi(router, wav, { fetchImpl });
    const json = JSON.parse(String(seen[1].init.body)) as { model: string; input_audio: { data: string; format: string } };
    assert.equal(seen[1].url, "https://openrouter.ai/api/v1/audio/transcriptions");
    assert.deepEqual([json.model, json.input_audio.format, Buffer.from(json.input_audio.data, "base64").length], ["vendor/paid-ears", "wav", wav.length]);

    assert.deepEqual(await transcribeWithApi(gemini, wav, { fetchImpl }).then((result) => result.ok && result.text), "hello there", "thought parts are dropped");
    const parts = (JSON.parse(String(seen[2].init.body)) as { contents: { parts: Record<string, unknown>[] }[] }).contents[0].parts;
    assert.ok(seen[2].url.endsWith("/models/gemini-3.5-transcribe:generateContent"));
    assert.equal(parts.length, 1, "a dedicated transcribe model gets no instruction");
    assert.equal((seen[2].init.headers as Record<string, string>)["x-goog-api-key"], "fixture-free");
    await transcribeWithApi({ ...gemini, modelId: "gemini-3.8-flash" }, wav, { fetchImpl });
    assert.equal((JSON.parse(String(seen[3].init.body)) as { contents: { parts: Record<string, unknown>[] }[] }).contents[0].parts.length, 2, "a general model is told to transcribe");
});

await check("API failures are classed: 410 carries the retirement date, 429 is transient, a hang times out", async () => {
    const route = apiTranscriptionRoute(choice("api"), false)!;
    const gone = await transcribeWithApi(route, wav, { fetchImpl: (async () => Response.json({ error: { message: "The model has reached its end of life on 2026-12-01" } }, { status: 410 })) as typeof fetch });
    assert.ok(!gone.ok && gone.status === 410 && !gone.transient && gone.retiredAt?.startsWith("2026-12-01"));
    const busy = await transcribeWithApi(route, wav, { fetchImpl: (async () => Response.json({ error: "slow down" }, { status: 429 })) as typeof fetch });
    assert.ok(!busy.ok && busy.transient && busy.status === 429);
    // AbortSignal.timeout does not hold the event loop open; a real socket would, so the fake holds a timer.
    const hang = await transcribeWithApi(route, wav, { timeoutMs: 20, fetchImpl: ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 5000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); reject(init.signal!.reason); });
    })) as typeof fetch });
    assert.ok(!hang.ok && hang.status === null && hang.transient);
    const blank = await transcribeWithApi(route, wav, { fetchImpl: (async () => Response.json({ nothing: true })) as typeof fetch });
    assert.ok(!blank.ok && blank.error === "The reply had no transcript.");
    assert.equal(wordAccuracy("the quick brown fox", "The quick, brown fox!"), 1);
});

const localSays = (result: SttResult) => async () => result;
const apiSays = (result: ApiSttResult) => async () => result;
const LOCAL_OK: SttResult = { ok: true, text: "from the box", audioSec: 1, decodeMs: 50, model: "moonshine-tiny-en" };
const API_OK: ApiSttResult = { ok: true, text: " from the api ", ms: 300 };
const apiFail = (status: number | null, transient: boolean): ApiSttResult => ({ ok: false, status, error: "nope", transient, retiredAt: null, ms: 10 });

await check("the order falls through on failure and stops on success, silence or an oversized clip", async () => {
    const apiRoute = apiTranscriptionRoute(choice("api"), false);
    let localCalls = 0, apiCalls = 0;
    const local = (result: SttResult) => async () => { localCalls++; return result; };
    const api = (result: ApiSttResult) => async () => { apiCalls++; return result; };
    const run = (steps: ("local" | "api")[], l: SttResult, a: ApiSttResult) => transcribeInOrder(pcm(32000), { steps, apiRoute, local: local(l), api: api(a) });

    assert.deepEqual(await run(["local", "api"], { ok: false, reason: "busy" }, API_OK), { ok: true, text: "from the api", audioSec: 1, engine: "api", model: "whisper-large-v3-turbo" });
    assert.deepEqual(await run(["api", "local"], LOCAL_OK, apiFail(503, true)).then((result) => result.ok && result.engine), "local");
    localCalls = apiCalls = 0;
    assert.deepEqual(await run(["api", "local"], LOCAL_OK, { ok: true, text: "   ", ms: 5 }), { ok: false, reason: "empty" }, "silence from the API is final");
    assert.equal(localCalls, 0);
    apiCalls = 0;
    assert.deepEqual(await run(["local", "api"], { ok: false, reason: "too_large" }, API_OK), { ok: false, reason: "too_large" });
    assert.equal(apiCalls, 0);
    assert.deepEqual(await run(["api"], LOCAL_OK, apiFail(429, true)), { ok: false, reason: "busy" });
    assert.deepEqual(await run(["api"], LOCAL_OK, apiFail(null, true)), { ok: false, reason: "timeout" });
    assert.deepEqual(await run(["api"], LOCAL_OK, apiFail(400, false)), { ok: false, reason: "error" });
    assert.deepEqual(await run([], LOCAL_OK, API_OK), { ok: false, reason: "unconfigured" });
});

await check("the API step sends 16 kHz WAV and records an observation with no transcript in it", async () => {
    const apiRoute = apiTranscriptionRoute(choice("api"), false);
    let sent: Buffer | null = null;
    const observations: import("../src/lib/ai/model-observations").ModelCallObservation[] = [];
    const result = await withModelObservationCollector(observations, () => transcribeInOrder(pcm(32000), {
        steps: ["api"], apiRoute, api: async (_route: ApiSttRoute, body: Buffer) => { sent = body; return { ok: true, text: "PRIVATE WORDS", ms: 40 }; },
    }), [], ["personal"]);
    assert.ok(result.ok);
    assert.equal(sent!.subarray(0, 4).toString(), "RIFF");
    assert.equal(sent!.readUInt32LE(24), 16000);
    assert.equal(sent!.length, 44 + 32000);
    assert.equal(observations.length, 1);
    assert.deepEqual([observations[0].providerId, observations[0].modelId, observations[0].purpose, observations[0].status], ["groq", "whisper-large-v3-turbo", "transcription", "success"]);
    assert.ok(!JSON.stringify(observations).includes("PRIVATE"));
});

await check("a Telegram voice note follows the order piece by piece, and Free only keeps paid models off it", async () => {
    const decode = async () => [pcm(32000), pcm(32000), pcm(16000)];
    const replies = ["first piece", "", "third piece"];
    let piece = 0;
    const api = async (): Promise<ApiSttResult> => ({ ok: true, text: replies[piece++] ?? "", ms: 20 });
    const note = await transcribeVoiceNote(new Uint8Array(8), 4, { choice: choice("api"), freeOnly: true, configured: () => false, decode, api });
    assert.deepEqual(note, { ok: true, text: "first piece third piece", audioSec: 1.5 }, "an empty piece is skipped and adds no time");

    const paid = choice("api-first", "openrouter", "vendor/paid-ears");
    let paidCalls = 0;
    const viaBox = await transcribeVoiceNote(new Uint8Array(8), 4, {
        choice: paid, configured: () => true, decode: async () => [pcm(32000)], transcribe: localSays(LOCAL_OK),
        api: async () => { paidCalls++; return API_OK; },
    });
    assert.ok(viaBox.ok && viaBox.text === "from the box");
    assert.equal(paidCalls, 0, "Free only is the default for voice notes");
    assert.deepEqual(await transcribeVoiceNote(new Uint8Array(8), 4, { choice: paid, configured: () => false, decode }), { ok: false, reason: "unconfigured" });
    const withPaid = await transcribeVoiceNote(new Uint8Array(8), 4, { choice: paid, freeOnly: false, configured: () => true, decode: async () => [pcm(32000)], transcribe: localSays(LOCAL_OK), api: apiSays(API_OK) });
    assert.ok(withPaid.ok && withPaid.text === "from the api");
    const failed = await transcribeVoiceNote(new Uint8Array(8), 4, { choice: choice("api"), configured: () => false, decode, api: apiSays(apiFail(503, true)) });
    assert.deepEqual(failed, { ok: false, reason: "unavailable" }, "any failure hands the audio itself to the chat model");
    assert.deepEqual(await transcribeVoiceNote(new Uint8Array(8), 301, { choice: choice("api"), decode, api: apiSays(API_OK) }), { ok: false, reason: "too_long" });
});

setCatalogueSnapshotForTests([]);
console.log(`${checks} API speech-to-text checks passed`);
