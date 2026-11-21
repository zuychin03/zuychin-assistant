import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://voice-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_ORIGIN: "https://assistant.test",
    TELEGRAM_BOT_TOKEN: "fixture-bot", TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret", TELEGRAM_CHAT_ID: "1001",
    GEMINI_API_KEY: "fixture-gemini", STT_SERVICE_URL: "http://stt.test", STT_SERVICE_TOKEN: "fixture-stt",
});

// Windows SAPI speech, "Please add milk, eggs and bread to my shopping list for Saturday.", encoded like a
// Telegram voice note: Ogg Opus, mono, 48 kHz, 32 kbps, about 4.7 seconds.
const fixture = new Uint8Array(await readFile(new URL("./fixtures/telegram-voice.ogg", import.meta.url)));
const OWNER = "66666666-6666-4666-8666-666666666666";

type Seen = { url: URL; method: string; body: string | Uint8Array };
const seen: Seen[] = [];
let sttReply: (pcm: Uint8Array) => Response = () => Response.json({ text: "please add milk eggs and bread", audioSec: 4.7, decodeMs: 300, model: "fixture" });
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    const raw = init?.body;
    const body = typeof raw === "string" ? raw : raw instanceof Uint8Array ? raw : request ? await request.clone().text() : "";
    seen.push({ url, method, body });
    if (url.hostname === "voice-fixture.supabase.co") {
        if (url.pathname === "/rest/v1/assistant_channel_updates" && method === "POST") return Response.json([{ update_key: "claimed" }]);
        if (url.pathname === "/rest/v1/user_profiles" && method === "GET") return Response.json([{ id: OWNER, display_name: "Owner", system_prompt: null, preferences: {} }]);
        if (url.pathname === "/rest/v1/messages" && method === "POST") return Response.json([{ id: "88888888-8888-4888-8888-888888888888" }], { status: 201 });
        return Response.json([]);
    }
    if (url.hostname === "stt.test") return sttReply(body as Uint8Array);
    if (url.href === "https://api.telegram.org/botfixture-bot/getFile") return Response.json({ ok: true, result: { file_path: "voice/file_1.oga" } });
    if (url.href === "https://api.telegram.org/file/botfixture-bot/voice/file_1.oga") return new Response(fixture);
    if (url.hostname === "api.telegram.org") return Response.json({ ok: true, result: { message_id: 5 } });
    throw new Error(`Unexpected offline request to ${url.href}`);
};

const { decodeOggOpus, VoiceDecodeError } = await import("../src/lib/voice/ogg-opus");
const { transcribeVoiceNote, VOICE_NOTE_MAX_SECONDS, VOICE_NOTE_PIECE_SECONDS } = await import("../src/lib/voice/voice-note");
const { NextRequest } = await import("next/server");
const webhook = await import("../src/app/api/telegram/webhook/route");

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    seen.length = 0;
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

const bytesFor = (seconds: number) => seconds * 16000 * 2;
const ok = (text: string) => ({ ok: true as const, text, audioSec: 1, decodeMs: 1, model: "fixture" });

await check("a Telegram voice note decodes straight to 16 kHz mono PCM", async () => {
    const pieces = await decodeOggOpus(fixture, { maxSeconds: 300, pieceSeconds: 30 });
    assert.equal(pieces.length, 1);
    const seconds = pieces[0].byteLength / 32000;
    assert.ok(seconds > 4.3 && seconds < 5.1, `decoded ${seconds} s`);
    const samples = new Int16Array(pieces[0].buffer);
    assert.ok(samples.some((sample) => Math.abs(sample) > 3000), "the speech is audible, not silence");
});

await check("pieces never exceed the speech service's request size", async () => {
    const pieces = await decodeOggOpus(fixture, { maxSeconds: 300, pieceSeconds: 1 });
    assert.ok(pieces.length >= 5);
    for (const piece of pieces.slice(0, -1)) assert.equal(piece.byteLength, bytesFor(1));
    assert.ok(pieces.at(-1)!.byteLength <= bytesFor(1));
    assert.ok(VOICE_NOTE_PIECE_SECONDS * 32000 <= 60 * 32000, "a piece fits the service's 60-second limit");
});

await check("a note over the length limit, or bytes that are not Ogg Opus, fail as decode errors", async () => {
    await assert.rejects(decodeOggOpus(fixture, { maxSeconds: 2, pieceSeconds: 30 }), (error: unknown) => error instanceof VoiceDecodeError && error.reason === "too_long");
    await assert.rejects(decodeOggOpus(new TextEncoder().encode("not audio at all"), { maxSeconds: 300, pieceSeconds: 30 }),
        (error: unknown) => error instanceof VoiceDecodeError && (error.reason === "empty" || error.reason === "invalid"));
});

await check("transcription joins the pieces in order and skips silent ones", async () => {
    const calls: number[] = [];
    const decode = async () => [new Uint8Array(bytesFor(30)), new Uint8Array(bytesFor(30)), new Uint8Array(bytesFor(4))];
    const replies = [ok("first part"), { ok: false as const, reason: "empty" as const }, ok("last part")];
    const transcribe = async (pcm: Uint8Array<ArrayBuffer>) => { calls.push(pcm.byteLength); return replies[calls.length - 1]; };
    const result = await transcribeVoiceNote(fixture, 64, { configured: () => true, decode, transcribe });
    assert.deepEqual(result, { ok: true, text: "first part last part", audioSec: 2 });
    assert.deepEqual(calls, [bytesFor(30), bytesFor(30), bytesFor(4)]);
});

await check("every failure says why, so the webhook can fall back to the audio", async () => {
    let decoded = 0;
    const decode = async () => { decoded++; return [new Uint8Array(bytesFor(2))]; };
    assert.deepEqual(await transcribeVoiceNote(fixture, 5, { configured: () => false, decode }), { ok: false, reason: "unconfigured" });
    assert.deepEqual(await transcribeVoiceNote(fixture, VOICE_NOTE_MAX_SECONDS + 1, { configured: () => true, decode }), { ok: false, reason: "too_long" });
    assert.equal(decoded, 0, "neither case decodes anything");
    assert.deepEqual(await transcribeVoiceNote(fixture, 5, { configured: () => true, decode, transcribe: async () => ({ ok: false, reason: "busy" }) }), { ok: false, reason: "busy" });
    assert.deepEqual(await transcribeVoiceNote(fixture, 5, { configured: () => true, decode, transcribe: async () => ({ ok: false, reason: "empty" }) }), { ok: false, reason: "empty" });
    assert.deepEqual(await transcribeVoiceNote(fixture, 5, { configured: () => true, decode: async () => { throw new VoiceDecodeError("invalid"); } }), { ok: false, reason: "invalid" });
    assert.deepEqual(await transcribeVoiceNote(fixture, 5, { configured: () => true, decode: async () => { throw new Error("wasm"); } }), { ok: false, reason: "invalid" });
});

const voiceUpdate = (updateId: number) => new NextRequest("https://assistant.test/api/telegram/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "fixture-webhook-secret" },
    body: JSON.stringify({ update_id: updateId, message: { message_id: 3, chat: { id: 1001 }, from: { id: 1001 }, voice: { file_id: "voice-1", duration: 5, file_size: fixture.length } } }),
});
const sttCalls = () => seen.filter(({ url }) => url.hostname === "stt.test");
const savedUserMessages = () => seen
    .filter(({ url, method }) => url.pathname === "/rest/v1/messages" && method === "POST")
    .map(({ body }) => JSON.parse(String(body)))
    .flatMap((row) => Array.isArray(row) ? row : [row])
    .filter((row) => row.role === "user");

await check("the webhook sends the on-box transcript, marked as spoken, instead of the audio", async () => {
    await webhook.POST(voiceUpdate(301));
    assert.equal(sttCalls().length, 1);
    const pcm = sttCalls()[0].body as Uint8Array;
    assert.ok(pcm.byteLength > bytesFor(4.3) && pcm.byteLength < bytesFor(5.1));
    assert.equal(sttCalls()[0].url.pathname, "/transcribe");
    const saved = savedUserMessages();
    assert.equal(saved.length, 1, "the user's turn is saved once");
    assert.equal(saved[0].content, "please add milk eggs and bread");
    assert.equal(saved[0].metadata?.inputMode, "voice");
    assert.equal(saved[0].channel, "telegram");
});

await check("when the box cannot transcribe, the audio goes to the model and history says so", async () => {
    sttReply = () => Response.json({ error: "busy" }, { status: 503 });
    try {
        await webhook.POST(voiceUpdate(302));
    } finally {
        sttReply = () => Response.json({ text: "please add milk eggs and bread", audioSec: 4.7, decodeMs: 300, model: "fixture" });
    }
    const saved = savedUserMessages();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].content, "[Voice note, not transcribed]");
    assert.equal(saved[0].metadata?.inputMode, undefined);
});

console.log(`Telegram voice: ${passed} checks passed; all network transport was mocked.`);
