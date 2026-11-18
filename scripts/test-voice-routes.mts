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
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
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
} finally {
    console.log = log;
}
console.log("Voice routes: auth, same origin, content type, size and PCM checks, transcript success, fallback mapping, private logs, config-only status and warm-up passed offline.");
