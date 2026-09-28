import assert from "node:assert/strict";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://speech-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", GEMINI_API_KEY: "fixture-gemini", AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat" });
type Row = Record<string, unknown>;
const saved: Row[] = [];
let freeOnly = false, providerCalls = 0, mode: "success" | "failure" | "cancel" = "success";
const frame = { candidates: [{ content: { parts: [{ inlineData: { data: "AQIDBA==", mimeType: "audio/L16;rate=24000" } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8, totalTokenCount: 12 } };
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined, url = new URL(request?.url ?? String(input));
    if (url.hostname === "speech-fixture.supabase.co") {
        if (url.pathname.endsWith("/user_profiles")) return Response.json({ id: "11111111-1111-4111-8111-111111111111", preferences: { freeOnly } });
        assert.ok(url.pathname.endsWith("/model_call_observations"));
        saved.push(...JSON.parse(String(init?.body))); return new Response(null, { status: 201 });
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com"); providerCalls++;
    if (mode === "failure") return Response.json({ error: { message: "PRIVATE PROVIDER BODY", code: 403 } }, { status: 403 });
    if (mode === "cancel") {
        const signal = init?.signal ?? request?.signal;
        return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: frame.candidates[0].content }] })}\n\n`));
            signal?.addEventListener("abort", () => controller.error(new DOMException("cancelled", "AbortError")), { once: true });
        } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
};
const { POST } = await import("../src/app/api/tts/route");
const { NextRequest } = await import("next/server");
const req = (stream = false, authorised = true) => new NextRequest("https://fixture.invalid/api/tts", { method: "POST",
    headers: { "content-type": "application/json", ...(authorised ? { authorization: "Bearer fixture-chat" } : {}) }, body: JSON.stringify({ text: "PRIVATE SPEECH TEXT", stream }) });
assert.equal((await POST(req(false, false))).status, 401);
const crossOrigin = req(); crossOrigin.headers.set("origin", "https://sibling.fixture.invalid");
assert.equal((await POST(crossOrigin)).status, 403); assert.equal(providerCalls, 0);
freeOnly = true; assert.equal((await POST(req())).status, 409); assert.equal(providerCalls, 0); freeOnly = false;
const result = await POST(req()); assert.equal(result.status, 200);
assert.equal(Buffer.from(await result.arrayBuffer()).subarray(0, 4).toString(), "RIFF");
assert.equal(saved.length, 1); assert.equal(saved[0].purpose, "speech"); assert.equal(saved[0].status, "success"); assert.equal(saved[0].total_tokens, 12);
assert.equal(saved[0].message_id, null); assert.equal(result.headers.get("x-model-provider"), "gemini");
mode = "failure"; assert.equal((await POST(req())).status, 502); assert.equal(saved.length, 2); assert.equal(saved[1].status, "auth");
assert.equal(saved[1].total_tokens, null);
mode = "cancel"; const streaming = await POST(req(true)); assert.equal(streaming.status, 200);
const reader = streaming.body!.getReader(); await reader.read(); await reader.cancel();
assert.equal(saved.length, 3); assert.equal(saved[2].status, "aborted"); assert.equal(saved[2].total_tokens, null);
assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|fixture-gemini|fixture-service/);
console.log("Speech observations: actual SDK/route success, provider failure, consumer cancellation, auth, origin and Free only checks passed offline.");
