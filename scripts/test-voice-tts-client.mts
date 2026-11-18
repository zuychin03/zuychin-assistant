import assert from "node:assert/strict";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://tts-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", GEMINI_API_KEY: "fixture-gemini", AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat" });
delete process.env.TTS_SERVICE_URL; delete process.env.TTS_SERVICE_TOKEN; delete process.env.GEMINI_FREE_API_KEY;

const { isLocalVoice, SpeechUnavailable, streamLocalSpeech, ttsConfigured, ttsWarm } = await import("../src/lib/voice/tts-client");
const { DEFAULT_VOICE_PREFS, getVoicePrefs, planSpeech, replyVoicePlan, speechStream, synthesizeSpeech } = await import("../src/lib/ai/tts");

// AbortSignal.timeout timers do not keep Node alive, so hold the loop open while a stubbed fetch waits for one.
const keepAlive = setInterval(() => { }, 1000);
const env = { TTS_SERVICE_URL: "http://127.0.0.1:3011/", TTS_SERVICE_TOKEN: "fixture-token" };
type Seen = { url: string; init?: RequestInit };
function stub(respond: (seen: Seen) => Response | Promise<Response>) {
    const seen: Seen[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = { url: String(input), init };
        seen.push(call);
        return respond(call);
    }) as typeof fetch;
    return { seen, fetchImpl };
}
const pcm = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);
const audio = (chunks: Uint8Array[], headers: Record<string, string> = { "X-Sample-Rate": "24000" }) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); },
}), { headers });
const drain = async (iterable: AsyncIterable<unknown>) => { for await (const chunk of iterable) void chunk; };
const collect = async (iterable: AsyncIterable<{ pcm: Buffer }>) => { const out: Buffer[] = []; for await (const c of iterable) out.push(c.pcm); return out; };

// Configuration and voices.
assert.equal(ttsConfigured({}), false);
assert.equal(ttsConfigured({ TTS_SERVICE_URL: "http://127.0.0.1:3011" }), false);
assert.equal(ttsConfigured(env), true);
assert.deepEqual(["M2", "F2", "Kore", "", undefined].map(isLocalVoice), [true, true, false, false, false]);

// Request shape and chunk handling.
{
    const ok = stub(() => audio([pcm(100), pcm(51), pcm(49)]));
    const chunks = await collect(streamLocalSpeech("Hello there.", "M2", { env, fetchImpl: ok.fetchImpl }));
    assert.equal(ok.seen[0].url, "http://127.0.0.1:3011/speak");
    const headers = new Headers(ok.seen[0].init?.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-token");
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(ok.seen[0].init?.body)), { text: "Hello there.", voice: "M2" });
    assert.equal(chunks.reduce((n, c) => n + c.length, 0), 200);
    assert.ok(chunks.every((c) => c.length % 2 === 0), "chunks never hold half a sample");
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([pcm(100), pcm(51), pcm(49)]));
}
{
    const rate = stub(() => audio([pcm(10)], { "X-Sample-Rate": "22050" }));
    const first = (await streamLocalSpeech("Hi.", "F2", { env, fetchImpl: rate.fetchImpl }).next()).value!;
    assert.equal(first.sampleRate, 22050);
    const noHeader = stub(() => audio([pcm(10)], {}));
    assert.equal((await streamLocalSpeech("Hi.", "F2", { env, fetchImpl: noHeader.fetchImpl }).next()).value!.sampleRate, 24000);
}

// Every failure before audio is one SpeechUnavailable with a reason.
const reasonOf = async (run: () => AsyncIterable<unknown>) => {
    try { await drain(run()); } catch (error) { assert.ok(error instanceof SpeechUnavailable, String(error)); return error.reason; }
    return "none";
};
const statusReason = (code: number, body: unknown) => reasonOf(() => streamLocalSpeech("Hi.", "M2", { env, fetchImpl: stub(() => Response.json(body, { status: code })).fetchImpl }));
assert.equal(await reasonOf(() => streamLocalSpeech("Hi.", "M2", { env: {} })), "unconfigured");
assert.equal(await statusReason(422, { error: "unsupported_text" }), "unsupported");
assert.equal(await statusReason(503, { error: "busy" }), "busy");
assert.equal(await statusReason(503, { error: "loading" }), "loading");
assert.equal(await statusReason(503, { error: "queue_timeout" }), "unavailable");
assert.equal(await statusReason(401, { error: "unauthorised" }), "error");
assert.equal(await statusReason(500, { error: "synth_failed" }), "error");
assert.equal(await reasonOf(() => streamLocalSpeech("Hi.", "M2", { env, fetchImpl: stub(() => new Response(null, { status: 200 })).fetchImpl })), "error");
assert.equal(await reasonOf(() => streamLocalSpeech("Hi.", "M2", { env, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch })), "unavailable");
const slow = stub(({ init }) => new Promise<Response>((_, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort);
}));
assert.equal(await reasonOf(() => streamLocalSpeech("Hi.", "M2", { env, fetchImpl: slow.fetchImpl, firstAudioMs: 40 })), "timeout");

// A broken stream after audio started, and a caller's own abort.
{
    let sent = false;
    const broken = stub(() => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { if (!sent) { sent = true; controller.enqueue(pcm(20)); } else controller.error(new Error("socket closed")); },
    }), { headers: { "X-Sample-Rate": "24000" } }));
    const got: number[] = [];
    await assert.rejects(async () => { for await (const c of streamLocalSpeech("Hi.", "M2", { env, fetchImpl: broken.fetchImpl })) got.push(c.pcm.length); }, SpeechUnavailable);
    assert.deepEqual(got, [20]);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(drain(streamLocalSpeech("Hi.", "M2", { env, fetchImpl: slow.fetchImpl, signal: controller.signal })), { name: "AbortError" });
}

// Warm-up.
assert.equal(await ttsWarm({ env: {} }), "unconfigured");
assert.equal(await ttsWarm({ env, fetchImpl: stub(() => Response.json({ ok: true, loaded: true })).fetchImpl }), "ready");
assert.equal(await ttsWarm({ env, fetchImpl: stub(() => Response.json({ ok: true, loaded: false })).fetchImpl }), "loading");
assert.equal(await ttsWarm({ env, fetchImpl: stub(() => new Response("no", { status: 500 })).fetchImpl }), "down");
assert.equal(await ttsWarm({ env, fetchImpl: (async () => { throw new TypeError("refused"); }) as typeof fetch }), "down");
assert.equal(await ttsWarm({ env, timeoutMs: 30, fetchImpl: slow.fetchImpl }), "starting");

// Preferences.
assert.deepEqual(getVoicePrefs(undefined), DEFAULT_VOICE_PREFS);
assert.equal(DEFAULT_VOICE_PREFS.speechEngine, "auto");
assert.equal(DEFAULT_VOICE_PREFS.localVoice, "M2");
assert.deepEqual(getVoicePrefs({ voice: { speechEngine: "local", localVoice: "F2", replyWithVoice: "always" } }), { ...DEFAULT_VOICE_PREFS, speechEngine: "local", localVoice: "F2", replyWithVoice: "always" });
assert.equal(getVoicePrefs({ voice: { speechEngine: "robot", localVoice: "Kore" } }).speechEngine, "auto");
assert.equal(getVoicePrefs({ voice: { speechEngine: "robot", localVoice: "Kore" } }).localVoice, "M2");
assert.equal(getVoicePrefs({ voice: { voiceName: "Puck" } }).voiceName, "Puck");

// Engine choice. Free only with the free key set, then without.
const prefs = (voice: Record<string, unknown> = {}) => getVoicePrefs({ voice });
const plans = (envVars: Record<string, string | undefined>) => ({
    auto: planSpeech(prefs(), { freeOnly: false, env: envVars }),
    gemini: planSpeech(prefs({ speechEngine: "gemini" }), { freeOnly: false, env: envVars }),
    local: planSpeech(prefs({ speechEngine: "local" }), { freeOnly: false, env: envVars }),
});
{
    const up = plans(env), down = plans({});
    assert.equal(up.auto.local, "M2"); assert.equal(up.auto.gemini?.route.providerId, "gemini"); assert.equal(up.auto.gemini?.voiceName, "Kore");
    assert.equal(up.gemini.local, null); assert.equal(up.gemini.gemini?.route.providerId, "gemini");
    assert.equal(up.local.local, "M2"); assert.equal(up.local.gemini, null);
    assert.equal(down.auto.local, null); assert.notEqual(down.auto.gemini, null);
    assert.deepEqual(down.local, { local: null, gemini: null });
    assert.equal(planSpeech(prefs({ localVoice: "F2" }), { freeOnly: false, env }).local, "F2");
    assert.equal(planSpeech(prefs(), { freeOnly: false, voiceName: "Puck", env }).gemini?.voiceName, "Puck");

    // Free only: the free key is the only Gemini route, and on-box speech needs no key.
    assert.deepEqual(planSpeech(prefs(), { freeOnly: true, env }), { local: "M2", gemini: null });
    process.env.GEMINI_FREE_API_KEY = "fixture-free";
    const free = planSpeech(prefs(), { freeOnly: true, env });
    assert.equal(free.local, "M2"); assert.equal(free.gemini?.route.providerId, "gemini-free");
    assert.deepEqual(planSpeech(prefs(), { freeOnly: true, geminiFree: false, env }), { local: "M2", gemini: null });
    assert.deepEqual(planSpeech(prefs(), { freeOnly: true, env: {} }).local, null);
    delete process.env.GEMINI_FREE_API_KEY;

    // Telegram and Discord: preference first, and never the Gemini free key.
    const reply = (voice: Record<string, unknown>, options: { audioTurn: boolean; freeOnly: boolean }, e: Record<string, string> = env) => {
        const saved = { ...process.env }; Object.assign(process.env, e);
        try { return replyVoicePlan({ voice }, options); } finally { for (const key of Object.keys(e)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    };
    assert.equal(reply({ replyWithVoice: "off" }, { audioTurn: true, freeOnly: false }), null);
    assert.equal(reply({}, { audioTurn: false, freeOnly: false }), null);
    assert.notEqual(reply({}, { audioTurn: true, freeOnly: false }), null);
    assert.notEqual(reply({ replyWithVoice: "always" }, { audioTurn: false, freeOnly: false }), null);
    assert.deepEqual(reply({ replyWithVoice: "always" }, { audioTurn: false, freeOnly: true }), { local: "M2", gemini: null });
    assert.equal(reply({ replyWithVoice: "always" }, { audioTurn: false, freeOnly: true }, {}), null);
    assert.equal(reply({ replyWithVoice: "always", speechEngine: "gemini" }, { audioTurn: false, freeOnly: true }), null);
}

// speechStream: local first, one Gemini fallback only before audio, never a mid-reply switch.
let geminiCalls = 0;
let localMode: "ok" | "down" | "busy" | "broken" = "ok";
const localPcm = [pcm(480), pcm(480)];
const geminiFrame = { candidates: [{ content: { parts: [{ inlineData: { data: "AQIDBA==", mimeType: "audio/L16;rate=24000" } }] }, finishReason: "STOP" }] };
const spokenBodies: string[] = [];
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "tts-fixture.supabase.co") return url.pathname.endsWith("/user_profiles") ? Response.json({ id: "11111111-1111-4111-8111-111111111111", preferences: {} }) : new Response(null, { status: 201 });
    if (url.hostname === "tts.fixture.invalid") {
        init?.signal?.throwIfAborted();
        spokenBodies.push(String(init?.body));
        if (localMode === "down") throw new TypeError("fetch failed");
        if (localMode === "busy") return Response.json({ error: "busy" }, { status: 503 });
        if (localMode === "broken") { let n = 0; return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (n++ === 0) c.enqueue(localPcm[0]); else c.error(new Error("socket closed")); } }), { headers: { "X-Sample-Rate": "24000" } }); }
        return audio(localPcm);
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com"); geminiCalls++;
    return new Response(`data: ${JSON.stringify(geminiFrame)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
};
Object.assign(process.env, { TTS_SERVICE_URL: "http://tts.fixture.invalid:3011", TTS_SERVICE_TOKEN: "fixture-token" });
const auto = planSpeech(prefs(), { freeOnly: false });
const providers = async (plan: typeof auto, text = "A **bold** reply with `code`.") => {
    const chunks: { provider: string; model: string; sampleRate: number }[] = [];
    for await (const chunk of speechStream(text, plan)) chunks.push(chunk);
    return chunks;
};

let out = await providers(auto);
assert.deepEqual([...new Set(out.map((c) => c.provider))], ["local"]); assert.equal(out[0].model, "tiny-voca"); assert.equal(geminiCalls, 0);
assert.deepEqual(JSON.parse(spokenBodies.at(-1)!), { text: "A bold reply with code.", voice: "M2" });
localMode = "down"; out = await providers(auto);
assert.deepEqual([...new Set(out.map((c) => c.provider))], ["gemini"]); assert.equal(geminiCalls, 1);
localMode = "busy"; out = await providers(auto);
assert.deepEqual([...new Set(out.map((c) => c.provider))], ["gemini"]); assert.equal(geminiCalls, 2);
localMode = "broken";
const mixed: string[] = [];
await assert.rejects(async () => { for await (const c of speechStream("Hello there.", auto)) mixed.push(c.provider); }, SpeechUnavailable);
assert.deepEqual(mixed, ["local"]); assert.equal(geminiCalls, 2, "no Gemini voice after local audio started");
localMode = "down";
await assert.rejects(providers(planSpeech(prefs({ speechEngine: "local" }), { freeOnly: false })), SpeechUnavailable);
assert.equal(geminiCalls, 2, "a forced local voice never falls back");
localMode = "ok";
const before = spokenBodies.length;
out = await providers(planSpeech(prefs({ speechEngine: "gemini" }), { freeOnly: false }));
assert.deepEqual([...new Set(out.map((c) => c.provider))], ["gemini"]); assert.equal(spokenBodies.length, before, "a forced Gemini voice never calls the service");
await assert.rejects(providers(auto, "   "), /Nothing to speak/);
await assert.rejects(providers({ local: null, gemini: null }), /No speech route/);
const aborted = new AbortController(); aborted.abort();
await assert.rejects(drain(speechStream("Hello.", auto, 500, aborted.signal)), { name: "AbortError" });
assert.equal(geminiCalls, 3, "an abort never falls back, and only the forced Gemini request called Gemini again");

// Aggregated WAV (Telegram and Discord).
{
    const wav = await synthesizeSpeech("Hello there.", auto);
    assert.equal(wav.provider, "local"); assert.equal(wav.mimeType, "audio/wav"); assert.equal(wav.model, "tiny-voca");
    assert.equal(wav.buffer.subarray(0, 4).toString(), "RIFF"); assert.equal(wav.buffer.readUInt32LE(24), 24000);
    assert.equal(wav.buffer.length, 44 + 960);
    assert.deepEqual(wav.buffer.subarray(44), Buffer.concat(localPcm));
    localMode = "down";
    assert.equal((await synthesizeSpeech("Hello there.", auto)).provider, "gemini");
    localMode = "ok";
}

clearInterval(keepAlive);
console.log("Local speech client: request shape, chunk alignment, every failure reason, timeouts, abort, warm-up, preferences, engine plans, fallback only before audio, and WAV output passed offline.");
