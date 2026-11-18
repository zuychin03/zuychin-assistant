import assert from "node:assert/strict";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://speaker-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", GEMINI_API_KEY: "fixture-gemini", AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat",
    TTS_SERVICE_URL: "http://speaker.fixture.invalid:3011", TTS_SERVICE_TOKEN: "fixture-speaker-token" });
delete process.env.GEMINI_FREE_API_KEY;

type Row = Record<string, unknown>;
const observations: Row[] = [];
let preferences: Record<string, unknown> = {};
let local: "ok" | "down" | "unsupported" = "ok";
let geminiCalls = 0, localCalls = 0;
const spoken: string[] = [];
const localPcm = [new Uint8Array(960).fill(3), new Uint8Array(960).fill(5)];
const frame = { candidates: [{ content: { parts: [{ inlineData: { data: "AQIDBA==", mimeType: "audio/L16;rate=24000" } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8, totalTokenCount: 12 } };
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined, url = new URL(request?.url ?? String(input));
    if (url.hostname === "speaker-fixture.supabase.co") {
        if (url.pathname.endsWith("/user_profiles")) return Response.json({ id: "11111111-1111-4111-8111-111111111111", preferences });
        assert.ok(url.pathname.endsWith("/model_call_observations"));
        observations.push(...JSON.parse(String(init?.body))); return new Response(null, { status: 201 });
    }
    if (url.hostname === "speaker.fixture.invalid") {
        init?.signal?.throwIfAborted(); localCalls++;
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-speaker-token");
        spoken.push(String(init?.body));
        if (local === "down") throw new TypeError("fetch failed");
        if (local === "unsupported") return Response.json({ error: "unsupported_text" }, { status: 422 });
        return new Response(new ReadableStream<Uint8Array>({ start(c) { for (const p of localPcm) c.enqueue(p); c.close(); } }), { headers: { "X-Sample-Rate": "24000", "Content-Type": "application/octet-stream" } });
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com"); geminiCalls++;
    return new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
};
const { POST, GET } = await import("../src/app/api/tts/route");
const { discordSpeechAttachment } = await import("../src/lib/voice/discord-speech");
const { NextRequest } = await import("next/server");
const call = (body: Record<string, unknown> = {}) => new NextRequest("https://fixture.invalid/api/tts", { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fixture-chat" }, body: JSON.stringify({ text: "PRIVATE SPEECH TEXT", ...body }) });
const reset = () => { observations.length = 0; geminiCalls = 0; localCalls = 0; spoken.length = 0; local = "ok"; preferences = {}; };

// Default (auto): the on-box voice speaks and reports itself.
{
    reset();
    const res = await POST(call());
    assert.equal(res.status, 200); assert.equal(res.headers.get("x-model-provider"), "local"); assert.equal(res.headers.get("x-model-id"), "tiny-voca");
    assert.equal(res.headers.get("content-type"), "audio/wav");
    const wav = Buffer.from(await res.arrayBuffer());
    assert.equal(wav.subarray(0, 4).toString(), "RIFF"); assert.equal(wav.length, 44 + 1920);
    assert.equal(geminiCalls, 0); assert.equal(localCalls, 1);
    assert.equal(observations.length, 0, "on-box speech sends nothing to a model provider and records no provider observation");
    assert.deepEqual(JSON.parse(spoken[0]), { text: "PRIVATE SPEECH TEXT", voice: "M2" });

    const streamed = await POST(call({ stream: true }));
    assert.equal(streamed.status, 200); assert.equal(streamed.headers.get("x-model-provider"), "local");
    assert.equal(streamed.headers.get("x-sample-rate"), "24000"); assert.equal(streamed.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), Buffer.concat(localPcm));
}

// The saved voice preference picks the voice and the engine.
{
    reset(); preferences = { voice: { localVoice: "F2" } };
    await (await POST(call())).arrayBuffer();
    assert.equal(JSON.parse(spoken[0]).voice, "F2");
    reset(); preferences = { voice: { speechEngine: "gemini" } };
    const res = await POST(call()); await res.arrayBuffer();
    assert.equal(res.headers.get("x-model-provider"), "gemini"); assert.equal(localCalls, 0); assert.equal(geminiCalls, 1);
    assert.equal(observations.length, 1); assert.equal(observations[0].purpose, "speech");
    const prefsRes = await GET(new NextRequest("https://fixture.invalid/api/tts", { headers: { authorization: "Bearer fixture-chat" } }));
    assert.deepEqual((await prefsRes.json()).voice, { replyWithVoice: "onVoiceInput", voiceName: "Kore", speechEngine: "gemini", localVoice: "M2" });
}

// Fallback: service down or text it cannot read goes to Gemini once, with the right headers; a forced local voice does not.
{
    reset(); local = "down";
    const res = await POST(call()); await res.arrayBuffer();
    assert.equal(res.status, 200); assert.equal(res.headers.get("x-model-provider"), "gemini"); assert.equal(geminiCalls, 1);
    const streamed = await POST(call({ stream: true })); await streamed.arrayBuffer();
    assert.equal(streamed.headers.get("x-model-provider"), "gemini"); assert.equal(geminiCalls, 2);
    reset(); local = "unsupported";
    const other = await POST(call()); await other.arrayBuffer();
    assert.equal(other.headers.get("x-model-provider"), "gemini");
    reset(); local = "down"; preferences = { voice: { speechEngine: "local" } };
    const forced = await POST(call());
    assert.equal(forced.status, 502); assert.equal(geminiCalls, 0);
    assert.doesNotMatch(JSON.stringify(await forced.json()), /PRIVATE|fixture/);
}

// Free only: the on-box voice needs no Gemini key; without it and without the free key there is nothing eligible.
{
    reset(); preferences = { freeOnly: true };
    const res = await POST(call()); await res.arrayBuffer();
    assert.equal(res.status, 200); assert.equal(res.headers.get("x-model-provider"), "local"); assert.equal(geminiCalls, 0);
    local = "down";
    const withoutKey = await POST(call());
    assert.equal(withoutKey.status, 502); assert.equal(geminiCalls, 0, "Free only never spends the paid key");
    process.env.GEMINI_FREE_API_KEY = "fixture-free";
    const fallback = await POST(call()); await fallback.arrayBuffer();
    assert.equal(fallback.headers.get("x-model-provider"), "gemini-free");
    delete process.env.GEMINI_FREE_API_KEY;
    reset(); preferences = { freeOnly: true, voice: { speechEngine: "gemini" } };
    assert.equal((await POST(call())).status, 409); assert.equal(geminiCalls + localCalls, 0);
    const saved = { ...process.env }; delete process.env.TTS_SERVICE_URL;
    try { reset(); preferences = { freeOnly: true }; assert.equal((await POST(call())).status, 409); assert.equal(geminiCalls + localCalls, 0); }
    finally { process.env.TTS_SERVICE_URL = saved.TTS_SERVICE_URL; }
    reset(); delete process.env.TTS_SERVICE_URL; preferences = { voice: { speechEngine: "local" } };
    const none = await POST(call()); assert.equal(none.status, 503); assert.equal(geminiCalls, 0);
    process.env.TTS_SERVICE_URL = saved.TTS_SERVICE_URL;
}

// Discord: a reply.wav rides along only when the saved preference is "always".
{
    reset();
    assert.equal(await discordSpeechAttachment("A reply.", false), null, "the default preference is not always");
    assert.equal(localCalls, 0);
    preferences = { voice: { replyWithVoice: "off" } };
    assert.equal(await discordSpeechAttachment("A reply.", false), null);
    preferences = { voice: { replyWithVoice: "always" } };
    assert.equal(await discordSpeechAttachment("   ", false), null);
    const attachment = await discordSpeechAttachment("A reply.", false);
    assert.ok(attachment); assert.equal(attachment.name, "reply.wav"); assert.equal(attachment.mime, "audio/wav"); assert.equal(attachment.size, 44 + 1920);
    assert.equal(Buffer.from(attachment.base64, "base64").subarray(0, 4).toString(), "RIFF"); assert.equal(geminiCalls, 0);
    // Free only never uses the Gemini free key here: silent when the on-box voice is down.
    local = "down"; process.env.GEMINI_FREE_API_KEY = "fixture-free"; geminiCalls = 0;
    assert.equal(await discordSpeechAttachment("A reply.", true), null); assert.equal(geminiCalls, 0);
    delete process.env.GEMINI_FREE_API_KEY;
    // Outside Free only it falls back to Gemini, and a total failure costs nothing but the audio.
    geminiCalls = 0; assert.ok(await discordSpeechAttachment("A reply.", false)); assert.equal(geminiCalls, 1);
    preferences = { voice: { replyWithVoice: "always", speechEngine: "local" } };
    assert.equal(await discordSpeechAttachment("A reply.", false), null);
}

console.log("Speech routes: on-box default, saved engine and voice, Gemini fallback, forced engines, Free only, observations, and the Discord attachment passed offline.");
