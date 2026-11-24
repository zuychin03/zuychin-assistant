// Offline checks for the backup voice chosen on /admin: plan selection by mode and channel, voice fallback,
// and OpenAI-shaped audio at its own rate (PCM at 44.1 kHz, WAV parsed). The on-box voice is not configured here.
import assert from "node:assert/strict";
Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://speech-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-gemini", GEMINI_FREE_API_KEY: "fixture-free", OPENROUTER_API_KEY: "fixture-or", GROQ_API_KEY: "fixture-groq",
});
delete process.env.TTS_SERVICE_URL;

const { pcmToWav } = await import("../src/lib/voice/audio");
const tone = (seconds: number, rate: number) => {
    const out = Buffer.alloc(Math.round(seconds * rate) * 2);
    for (let index = 0; index < out.length / 2; index++) out.writeInt16LE(Math.round(6000 * Math.sin(index / 9)), index * 2);
    return out;
};
const requests: { host: string; path: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ host: url.hostname, path: url.pathname, body });
    if (url.hostname === "openrouter.ai") return new Response(new Uint8Array(tone(2, 44100)), { headers: { "content-type": "audio/pcm;rate=44100;channels=1" } });
    if (url.hostname === "api.groq.com") return new Response(new Uint8Array(pcmToWav(tone(2, 24000), 24000)), { headers: { "content-type": "audio/wav" } });
    if (url.hostname === "generativelanguage.googleapis.com") {
        const frame = { candidates: [{ content: { parts: [{ inlineData: { data: tone(1, 24000).toString("base64"), mimeType: "audio/L16;codec=pcm;rate=24000" } }] }, finishReason: "STOP" }] };
        return new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected request to ${url.hostname}`);
};

const { getVoicePrefs, planSpeech, replyVoicePlan, speechStream, synthesizeSpeech } = await import("../src/lib/ai/tts");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { setVoiceChoicesForTests, DEFAULT_TRANSCRIPTION } = await import("../src/lib/ai/voice-choices");
const { TTS_MODEL } = await import("../src/lib/gemini");
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    requests.length = 0;
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

function speechRow(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.replace(/^.*\//, ""), description: null, developer: null,
        free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: ["text"],
        listedTools: null, listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 1200,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null,
        firstSeenAt: "2026-11-24T00:00:00.000Z", lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: "2026-11-24T00:00:00.000Z", kind: "speech", traits: {},
        ...overrides,
    };
}
setCatalogueSnapshotForTests([
    speechRow({ providerId: "openrouter", modelId: "vendor/voice:free", traits: { voices: ["nadine", "bram"], audioFormat: "pcm", sampleRate: 44100 } }),
    speechRow({ providerId: "openrouter", modelId: "vendor/paid-voice", free: false, traits: { voices: ["ava"], audioFormat: "pcm" } }),
    speechRow({ providerId: "openrouter", modelId: "vendor/untested:free", approvedAt: null, probeStatus: "untested" }),
    speechRow({ providerId: "groq", modelId: "canopylabs/orpheus-v1-english", traits: { audioFormat: "wav" } }),
    speechRow({ providerId: "gemini-free", modelId: "gemini-3.8-flash-lite-tts" }),
]);
const prefs = (voice: Record<string, unknown> = {}) => getVoicePrefs({ voice });
const backup = (providerId: string, modelId: string, voice: string | null = null) => ({ providerId, modelId, voice });

await check("no backup chosen keeps today's Gemini voice on the paid key, or the free key in Free only", () => {
    setVoiceChoicesForTests({ speech: null, transcription: DEFAULT_TRANSCRIPTION });
    const paid = planSpeech(prefs(), { freeOnly: false, env: {} });
    assert.deepEqual(paid.api, { route: { providerId: "gemini" }, modelId: TTS_MODEL, voiceName: "Kore", engine: "gemini-generate" });
    assert.equal(planSpeech(prefs(), { freeOnly: true, env: {} }).api?.route.providerId, "gemini-free");
    assert.equal(planSpeech(prefs({ speechEngine: "local" }), { freeOnly: false, env: {} }).api, null);
});

await check("the chosen backup speaks; the profile's voice wins when the model has it, else the saved voice", () => {
    const chosen = backup("openrouter", "vendor/voice:free", "bram");
    const plan = planSpeech(prefs(), { freeOnly: false, env: {}, backup: chosen });
    assert.equal(plan.api?.engine, "openai-speech");
    assert.equal(plan.api?.modelId, "vendor/voice:free");
    assert.equal(plan.api?.voiceName, "bram", "Kore is not one of this model's voices");
    assert.equal(plan.api?.format, "pcm");
    assert.equal(planSpeech(prefs({ voiceName: "nadine" }), { freeOnly: false, env: {}, backup: chosen }).api?.voiceName, "nadine");
    assert.equal(planSpeech(prefs(), { freeOnly: false, env: {}, backup: backup("groq", "canopylabs/orpheus-v1-english") }).api?.voiceName, "autumn", "the model's default voice when none was saved");
    const gemini = planSpeech(prefs({ voiceName: "Puck" }), { freeOnly: false, env: {}, backup: backup("gemini-free", "gemini-3.8-flash-lite-tts", "Kore") });
    assert.deepEqual([gemini.api?.engine, gemini.api?.voiceName, gemini.api?.route.providerId], ["gemini-generate", "Puck", "gemini-free"]);
});

await check("Free only uses a free backup, else the free Gemini key; Telegram and Discord stay on-box only", () => {
    assert.equal(planSpeech(prefs(), { freeOnly: true, env: {}, backup: backup("openrouter", "vendor/voice:free", "bram") }).api?.modelId, "vendor/voice:free");
    const paidChoice = planSpeech(prefs(), { freeOnly: true, env: {}, backup: backup("openrouter", "vendor/paid-voice", "ava") });
    assert.deepEqual([paidChoice.api?.route.providerId, paidChoice.api?.modelId], ["gemini-free", TTS_MODEL]);
    assert.equal(planSpeech(prefs(), { freeOnly: true, geminiFree: false, env: {}, backup: backup("openrouter", "vendor/voice:free", "bram") }).api, null);
    setVoiceChoicesForTests({ speech: backup("openrouter", "vendor/voice:free", "bram"), transcription: DEFAULT_TRANSCRIPTION });
    assert.equal(replyVoicePlan({ voice: { replyWithVoice: "always" } }, { audioTurn: false, freeOnly: true }), null, "no on-box voice and Free only: silent");
    assert.equal(replyVoicePlan({ voice: { replyWithVoice: "always" } }, { audioTurn: false, freeOnly: false })?.api?.modelId, "vendor/voice:free");
    setVoiceChoicesForTests({ speech: null, transcription: DEFAULT_TRANSCRIPTION });
});

await check("an unapproved or untested choice falls back to the default voice", () => {
    const plan = planSpeech(prefs(), { freeOnly: false, env: {}, backup: backup("openrouter", "vendor/untested:free") });
    assert.deepEqual([plan.api?.route.providerId, plan.api?.modelId], ["gemini", TTS_MODEL]);
    const missing = planSpeech(prefs(), { freeOnly: false, env: {}, backup: backup("openrouter", "vendor/gone") });
    assert.equal(missing.api?.modelId, TTS_MODEL);
});

await check("OpenAI-shaped audio keeps its rate: 44.1 kHz PCM streams, WAV is parsed, the WAV file says the right rate", async () => {
    const plan = planSpeech(prefs(), { freeOnly: false, env: {}, backup: backup("openrouter", "vendor/voice:free", "bram") });
    const chunks: { sampleRate: number; provider: string; model: string; bytes: number }[] = [];
    for await (const chunk of speechStream("Hello from the backup voice.", plan)) chunks.push({ sampleRate: chunk.sampleRate, provider: chunk.provider, model: chunk.model, bytes: chunk.pcm.length });
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((chunk) => chunk.sampleRate === 44100 && chunk.provider === "openrouter" && chunk.model === "vendor/voice:free"));
    assert.equal(chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), 2 * 44100 * 2);
    assert.deepEqual([requests[0].path, requests[0].body.voice, requests[0].body.response_format], ["/api/v1/audio/speech", "bram", "pcm"]);
    const wav = await synthesizeSpeech("Hello.", planSpeech(prefs(), { freeOnly: false, env: {}, backup: backup("groq", "canopylabs/orpheus-v1-english", "diana") }));
    assert.equal(wav.provider, "groq");
    assert.equal(wav.buffer.readUInt32LE(24), 24000);
    assert.equal(requests.at(-1)!.body.response_format, "wav", "the probe's format skips the PCM attempt");
    const gemini = await synthesizeSpeech("Hello.", planSpeech(prefs(), { freeOnly: false, env: {} }));
    assert.deepEqual([gemini.provider, gemini.model, gemini.buffer.readUInt32LE(24)], ["gemini", TTS_MODEL, 24000]);
});

setCatalogueSnapshotForTests([]);
console.log(`${checks} backup voice checks passed`);
