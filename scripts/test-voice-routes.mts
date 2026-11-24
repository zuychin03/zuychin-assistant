import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://voice-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-gemini", AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat",
    STT_SERVICE_URL: "http://127.0.0.1:3010", STT_SERVICE_TOKEN: "fixture-stt-token",
});
type Seen = { url: URL; headers: Headers; body: Uint8Array };
const seen: Seen[] = [];
let reply: () => Response = () => Response.json({ text: "PRIVATE SPOKEN WORDS", audioSec: 2, decodeMs: 90, model: "moonshine-tiny-en" });
let health: () => Response = () => Response.json({ ok: true, model: "moonshine-tiny-en", loaded: true, busy: false, waiting: 0 });
let speakerWakes = 0;
let apiReply: () => Response = () => Response.json({ candidates: [{ content: { parts: [{ text: "PRIVATE API WORDS" }] } }] });
const apiCalls: { url: URL; body: string }[] = [];
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    if (url.hostname === "generativelanguage.googleapis.com") {
        apiCalls.push({ url, body: String(init?.body) });
        return apiReply();
    }
    // The speech service is only configured for the warm-up's speaker checks.
    if (url.host === "127.0.0.1:3011" && url.pathname === "/health") {
        speakerWakes += 1;
        return Response.json({ ok: true, loaded: false });
    }
    assert.equal(url.host, "127.0.0.1:3010", `unexpected request to ${url.host}`);
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
    seen.push({ url, headers: new Headers(init?.headers), body });
    return url.pathname === "/health" ? health() : reply();
};
const logs: string[] = [];
const log = console.log;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

const { POST } = await import("../src/app/api/voice/transcribe/route");
const { GET } = await import("../src/app/api/voice/status/route");
const { POST: WARM } = await import("../src/app/api/voice/warm/route");
const { NextRequest } = await import("next/server");

const pcm = (bytes: number) => new Uint8Array(bytes).fill(1);
function req(body: Uint8Array, options: { auth?: boolean; type?: string; origin?: string } = {}) {
    const headers: Record<string, string> = { "content-type": options.type ?? "application/octet-stream" };
    if (options.auth !== false) headers.authorization = "Bearer fixture-chat";
    if (options.origin) headers.origin = options.origin;
    return new NextRequest("https://fixture.invalid/api/voice/transcribe", { method: "POST", headers, body: body as BodyInit });
}
const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });

try {
    assert.equal((await POST(req(pcm(32000), { auth: false }))).status, 401);
    assert.equal((await POST(req(pcm(32000), { origin: "https://sibling.fixture.invalid" }))).status, 403);
    assert.equal((await POST(req(pcm(32000), { type: "audio/webm" }))).status, 415);
    assert.equal((await POST(req(pcm(1_920_002)))).status, 413);
    assert.equal((await POST(req(pcm(0)))).status, 400);
    assert.equal((await POST(req(pcm(3)))).status, 400);
    assert.equal(seen.length, 0, "rejected requests never reach the service");

    const okBody = pcm(64000);
    const ok = await json(await POST(req(okBody)));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.text, "PRIVATE SPOKEN WORDS");
    assert.equal(ok.body.audioSec, 2);
    assert.equal(typeof ok.body.ms, "number");
    assert.equal(seen[0].url.pathname, "/transcribe");
    assert.equal(seen[0].headers.get("authorization"), "Bearer fixture-stt-token");
    assert.equal(seen[0].headers.get("x-sample-rate"), "16000");
    assert.equal(seen[0].body.byteLength, okBody.byteLength);

    reply = () => Response.json({ error: "busy" }, { status: 503 });
    assert.deepEqual(await json(await POST(req(pcm(32000)))), { status: 503, body: { fallback: true, reason: "busy" } });
    reply = () => { throw new TypeError("fetch failed"); };
    assert.deepEqual(await json(await POST(req(pcm(32000)))), { status: 503, body: { fallback: true, reason: "unavailable" } });
    reply = () => Response.json({ text: "" });
    assert.deepEqual(await json(await POST(req(pcm(32000)))), { status: 503, body: { fallback: true, reason: "empty" } });

    const before = seen.length;
    process.env.STT_SERVICE_TOKEN = "";
    try {
        assert.deepEqual(await json(await POST(req(pcm(32000)))), { status: 503, body: { fallback: true, reason: "unconfigured" } });
        assert.equal(seen.length, before);
    } finally { process.env.STT_SERVICE_TOKEN = "fixture-stt-token"; }

    const transcribeLogs = logs.filter((line) => line.includes("voice_transcribe"));
    assert.equal(transcribeLogs.length, 4);
    assert.ok(transcribeLogs.every((line) => !line.includes("PRIVATE")), "logs carry no transcript text");

    const healthCalls = () => seen.filter((call) => call.url.pathname === "/health").length;
    const statusReq = (auth = true) => new NextRequest("https://fixture.invalid/api/voice/status", { headers: auth ? { authorization: "Bearer fixture-chat" } : {} });
    assert.equal((await GET(statusReq(false))).status, 401);
    assert.deepEqual(await json(await GET(statusReq())), { status: 200, body: { available: true } });
    process.env.STT_SERVICE_URL = "";
    try { assert.deepEqual(await json(await GET(statusReq())), { status: 200, body: { available: false } }); }
    finally { process.env.STT_SERVICE_URL = "http://127.0.0.1:3010"; }
    assert.equal(healthCalls(), 0, "status never contacts the service, which would start it");

    const warmReq = (options: { auth?: boolean; origin?: string } = {}) => {
        const headers: Record<string, string> = {};
        if (options.auth !== false) headers.authorization = "Bearer fixture-chat";
        if (options.origin) headers.origin = options.origin;
        return new NextRequest("https://fixture.invalid/api/voice/warm", { method: "POST", headers });
    };
    assert.equal((await WARM(warmReq({ auth: false }))).status, 401);
    assert.equal((await WARM(warmReq({ origin: "https://sibling.fixture.invalid" }))).status, 403);
    assert.equal(healthCalls(), 0, "refused warm-ups never reach the service");
    health = () => Response.json({ ok: true, loaded: false });
    assert.deepEqual(await json(await WARM(warmReq())), { status: 200, body: { available: true, loaded: false } }, "a loading model counts as available");
    health = () => Response.json({ ok: true, loaded: true });
    assert.deepEqual(await json(await WARM(warmReq())), { status: 200, body: { available: true, loaded: true } });
    health = () => { throw new TypeError("fetch failed"); };
    assert.deepEqual(await json(await WARM(warmReq())), { status: 200, body: { available: false, loaded: false } }, "a refused connection is unavailable");
    assert.equal(healthCalls(), 3);
    assert.equal(logs.filter((line) => line.includes("voice_warm")).length, 3);

    Object.assign(process.env, { TTS_SERVICE_URL: "http://127.0.0.1:3011", TTS_SERVICE_TOKEN: "fixture-tts-token" });
    try {
        health = () => Response.json({ ok: true, loaded: false });
        assert.deepEqual(await json(await WARM(warmReq())), { status: 200, body: { available: true, loaded: false } });
        assert.equal(speakerWakes, 0, "the voice waits while speech-to-text loads");
        health = () => Response.json({ ok: true, loaded: true });
        assert.deepEqual(await json(await WARM(warmReq())), { status: 200, body: { available: true, loaded: true } });
        assert.equal(speakerWakes, 1, "the voice starts once speech-to-text has loaded");
        health = () => { throw new TypeError("fetch failed"); };
        assert.deepEqual(await json(await WARM(warmReq())), { status: 200, body: { available: false, loaded: false } });
        assert.equal(speakerWakes, 2, "a missing transcriber does not hold the voice back");
        assert.ok(logs.some((line) => line.includes('"speaker":"deferred"')) && logs.some((line) => line.includes('"speaker":"started"')));
    } finally {
        delete process.env.TTS_SERVICE_URL;
        delete process.env.TTS_SERVICE_TOKEN;
    }

    // API transcription in the owner's order (chosen on /admin), with the on-box service as the other step.
    const { setVoiceChoicesForTests } = await import("../src/lib/ai/voice-choices");
    const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
    process.env.GEMINI_FREE_API_KEY = "fixture-free";
    const transcribeRow = (approved: boolean) => ({
        providerId: "gemini-free", modelId: "gemini-3.5-transcribe", origin: "discovered" as const, label: "Gemini 3.5 Transcribe", shortName: "gemini-3.5-transcribe-free",
        description: null, developer: null, free: true, metered: false, mayTrain: true, contextTokens: null, maxOutputTokens: null, inputs: ["audio"],
        listedTools: null, listedStructured: null, listedThinking: null, probeStatus: "passed" as const, probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 2900,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null,
        firstSeenAt: "2026-11-24T00:00:00.000Z", lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: approved ? "2026-11-24T00:00:00.000Z" : null, kind: "transcription" as const, traits: { accuracy: 1 },
    });
    const choose = (order: "local" | "local-first" | "api-first" | "api") => setVoiceChoicesForTests({ speech: null, transcription: { order, providerId: "gemini-free", modelId: "gemini-3.5-transcribe" } });
    setCatalogueSnapshotForTests([transcribeRow(true)]);
    reply = () => Response.json({ text: "PRIVATE SPOKEN WORDS", audioSec: 2, decodeMs: 90, model: "moonshine-tiny-en" });
    try {
        choose("api-first");
        const localBefore = seen.length;
        const viaApi = await json(await POST(req(pcm(32000))));
        assert.equal(viaApi.status, 200);
        assert.equal(viaApi.body.text, "PRIVATE API WORDS");
        assert.equal(viaApi.body.engine, "api");
        assert.equal(seen.length, localBefore, "api-first never waits for the box when the API answers");
        const inline = (JSON.parse(apiCalls[0].body) as { contents: { parts: { inlineData?: { mimeType: string; data: string } }[] }[] }).contents[0].parts[0].inlineData!;
        const wav = Buffer.from(inline.data, "base64");
        assert.equal(inline.mimeType, "audio/wav");
        assert.equal(wav.subarray(0, 4).toString(), "RIFF");
        assert.equal(wav.readUInt32LE(24), 16000);
        assert.equal(wav.length, 44 + 32000);

        choose("local-first");
        reply = () => Response.json({ error: "busy" }, { status: 503 });
        const busyBox = await json(await POST(req(pcm(32000))));
        assert.equal(busyBox.body.engine, "api", "a busy box hands the turn to the API model");
        assert.equal(seen.length, localBefore + 1);

        choose("api-first");
        apiReply = () => Response.json({ error: { message: "overloaded" } }, { status: 503 });
        reply = () => Response.json({ text: "PRIVATE SPOKEN WORDS", audioSec: 2, decodeMs: 90, model: "moonshine-tiny-en" });
        const apiDown = await json(await POST(req(pcm(32000))));
        assert.equal(apiDown.body.engine, "local", "a failed API call falls to the box");

        choose("api");
        const apiOnly = await json(await POST(req(pcm(32000))));
        assert.deepEqual(apiOnly, { status: 503, body: { fallback: true, reason: "unavailable" } }, "API only never uses the box");
        assert.equal(seen.length, localBefore + 2);

        setCatalogueSnapshotForTests([transcribeRow(false)]);
        apiReply = () => Response.json({ candidates: [{ content: { parts: [{ text: "PRIVATE API WORDS" }] } }] });
        const callsBefore = apiCalls.length;
        assert.deepEqual(await json(await POST(req(pcm(32000)))), { status: 503, body: { fallback: true, reason: "unconfigured" } }, "an unapproved model is never used");
        assert.equal(apiCalls.length, callsBefore);
        assert.ok(logs.filter((line) => line.includes("voice_transcribe")).every((line) => !line.includes("PRIVATE")), "logs carry no transcript text");
    } finally {
        choose("local");
        setCatalogueSnapshotForTests([]);
        delete process.env.GEMINI_FREE_API_KEY;
    }
} finally {
    console.log = log;
}
console.log("Voice routes: auth, same origin, content type, size and PCM checks, transcript success, fallback mapping, private logs, config-only status, warm-up and API transcription orders passed offline.");
