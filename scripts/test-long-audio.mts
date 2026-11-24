// Offline checks for V8 F5 and F6: Capture recordings cut into 3-minute pieces, the piece and summary routes,
// Telegram audio over 5 minutes with Save to Capture, and Discord voice messages. Every request goes to a fake fetch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://audio-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat", AUTH_ORIGIN: "https://assistant.test",
    GROQ_API_KEY: "fixture-groq", GEMINI_FREE_API_KEY: "fixture-free", GEMINI_API_KEY: "fixture-gemini",
    STT_SERVICE_URL: "http://stt.test", STT_SERVICE_TOKEN: "fixture-stt",
    TELEGRAM_BOT_TOKEN: "fixture-bot", TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret", TELEGRAM_CHAT_ID: "1001",
});

// Windows SAPI speech encoded like a Telegram voice note: Ogg Opus, mono, 48 kHz, about 4.7 seconds.
const fixture = new Uint8Array(await readFile(new URL("./fixtures/telegram-voice.ogg", import.meta.url)));
const OWNER = "66666666-6666-4666-8666-666666666666";

type Seen = { url: URL; method: string; body: unknown };
const seen: Seen[] = [];
let sttReply: (pcm: Uint8Array) => Response = () => Response.json({ text: "box words", audioSec: 30, decodeMs: 5, model: "moonshine-tiny-en" });
let groqReply: () => Response = () => Response.json({ text: "api words" });
let geminiReply: () => Response = () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "Week 3 lecture", summary: "It covered retrieval.\n\n- Rerank before reading" }) }] }, finishReason: "STOP" }] });
let telegramFile: Uint8Array<ArrayBuffer> = fixture;
const captureRows = new Map<string, Record<string, unknown>>();
const rows = (accept: string | null, list: Record<string, unknown>[]) => accept?.includes("vnd.pgrst.object") ? Response.json(list[0] ?? null) : Response.json(list);
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    const body = init?.body ?? (request ? await request.clone().text() : undefined);
    const accept = new Headers(init?.headers ?? request?.headers).get("accept");
    seen.push({ url, method, body });
    if (url.hostname === "audio-fixture.supabase.co") {
        if (url.pathname.endsWith("/user_profiles")) return rows(accept, [{ id: OWNER, display_name: "Owner", system_prompt: null, preferences: {} }]);
        if (url.pathname.endsWith("/model_call_observations")) return new Response(null, { status: 201 });
        if (url.pathname.endsWith("/assistant_channel_updates") && method === "POST") return Response.json([{ update_key: "claimed" }]);
        if (url.pathname.endsWith("/messages") && method === "POST") return Response.json([{ id: "88888888-8888-4888-8888-888888888888" }], { status: 201 });
        if (url.pathname.endsWith("/capture_inbox")) {
            if (method === "POST") {
                const row = JSON.parse(String(body)) as Record<string, unknown>;
                if (!captureRows.has(String(row.id))) captureRows.set(String(row.id), { ...row, created_at: "2026-11-25T00:00:00.000Z", receipt: null });
                return new Response(null, { status: 201 });
            }
            const id = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
            return rows(accept, captureRows.has(id) ? [captureRows.get(id)!] : []);
        }
        return Response.json([]);
    }
    if (url.hostname === "stt.test") return sttReply(body as Uint8Array);
    if (url.hostname === "api.groq.com") return groqReply();
    if (url.hostname === "generativelanguage.googleapis.com") return geminiReply();
    if (url.href === "https://api.telegram.org/botfixture-bot/getFile") return Response.json({ ok: true, result: { file_path: "voice/long.oga" } });
    if (url.href === "https://api.telegram.org/file/botfixture-bot/voice/long.oga") return new Response(telegramFile);
    if (url.hostname === "api.telegram.org") return Response.json({ ok: true, result: { message_id: 9 } });
    throw new Error(`Unexpected offline request to ${url.href}`);
};
const logs: string[] = [];
const log = console.log;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

const { NextRequest } = await import("next/server");
const limits = await import("../src/lib/voice/recording-limits");
const { bodyLimit, NEXT_BODY_LIMIT, RECORDING_PIECE_BODY_LIMIT, RECORDING_SUMMARY_BODY_LIMIT } = await import("../src/lib/http/limits");
const { SOURCE_TEXT_MAX } = await import("../src/lib/capture/service");
const { VOICE_NOTE_MAX_SECONDS } = await import("../src/lib/voice/voice-note");
const { mixToPcm, recordingFromPcm, transcribeRecording, recordingBody } = await import("../src/lib/capture/audio-pieces");
const { apiAudioLimit, audioFormat, transcribeAudioWithApi } = await import("../src/lib/voice/api-stt");
const { oggOpusSeconds } = await import("../src/lib/voice/ogg-opus");
const { recordingSteps, transcribeRecordingPiece, transcribeLongAudio, longAudioFailureText } = await import("../src/lib/voice/long-audio");
const { longRecording, recordingTitle, transcriptHeading, parseTranscriptMessage, transcriptCaptureId } = await import("../src/lib/messaging/telegram-recording");
const { discordVoice, transcriptReply, botPlaceholder, isDiscordVoice } = await import("../src/lib/voice/discord-voice");
const { parseRecordingSummary } = await import("../src/lib/capture/recording-summary");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { setVoiceChoicesForTests } = await import("../src/lib/ai/voice-choices");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
const pieceRoute = await import("../src/app/api/capture/transcribe-piece/route");
const recordingRoute = await import("../src/app/api/capture/recording/route");
const webhook = await import("../src/app/api/telegram/webhook/route");
const chatRoute = await import("../src/app/api/chat/route");
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;
type TranscriptionChoice = import("../src/lib/ai/voice-choices").TranscriptionChoice;

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    seen.length = 0;
    logs.length = 0;
    await run();
    passed++;
    log(`PASS ${name}`);
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
    sttRow({ providerId: "groq", modelId: "paid-ears", free: false }),
    sttRow({ providerId: "gemini-free", modelId: "gemini-3.5-transcribe" }),
]);
const choice = (order: TranscriptionChoice["order"], providerId = "groq", modelId = "whisper-large-v3-turbo"): TranscriptionChoice => ({ order, providerId, modelId });
const useChoice = (value: TranscriptionChoice) => setVoiceChoicesForTests({ speech: null, transcription: value });
const pcmBytes = (seconds: number) => new Uint8Array(new ArrayBuffer(seconds * 32000));

function oggPage(granule: bigint, payload: Uint8Array): Uint8Array {
    const page = new Uint8Array(28 + payload.length);
    page.set([0x4f, 0x67, 0x67, 0x53]);
    const view = new DataView(page.buffer);
    view.setBigUint64(6, granule, true);
    view.setUint32(14, 7, true);
    page[26] = 1;
    page[27] = payload.length;
    page.set(payload, 28);
    return page;
}
/** Two Ogg pages, OpusHead and one audio page whose granule gives the length; never decoded. */
function fakeOpus(seconds: number): Uint8Array {
    const head = new Uint8Array(19);
    head.set(new TextEncoder().encode("OpusHead"));
    head[8] = 1; head[9] = 1;
    new DataView(head.buffer).setUint16(10, 312, true);
    const first = oggPage(BigInt(0), head), last = oggPage(BigInt(Math.round(seconds * 48000) + 312), new Uint8Array(200).fill(1));
    const out = new Uint8Array(first.length + last.length);
    out.set(first); out.set(last, first.length);
    return out;
}
const formOf = (entry: Seen) => entry.body instanceof FormData ? entry.body : null;
const telegramSends = (method: string) => seen.filter(({ url }) => url.hostname === "api.telegram.org" && url.pathname.endsWith(`/${method}`));
type Sent = { text: string; parse_mode?: string; reply_markup?: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } };
/** MarkdownV2 sends arrive escaped; the plain-text transcript arrives as it is. */
const sentText = (entry: Seen): Sent => {
    const sent = JSON.parse(String(entry.body)) as Sent;
    return sent.parse_mode === "MarkdownV2" ? { ...sent, text: sent.text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1").trim() } : sent;
};
const savedMessages = () => seen.filter(({ url, method }) => url.pathname === "/rest/v1/messages" && method === "POST")
    .map(({ body }) => JSON.parse(String(body))).flatMap((row) => Array.isArray(row) ? row : [row]);

await check("recordings put an API model first unless the owner keeps audio on the box", () => {
    assert.deepEqual(recordingSteps("local", true, true), ["local"]);
    assert.deepEqual(recordingSteps("local-first", true, true), ["api", "local"], "the box is too slow to lead on long audio");
    assert.deepEqual(recordingSteps("api-first", true, true), ["api", "local"]);
    assert.deepEqual(recordingSteps("api", true, true), ["api"]);
    assert.deepEqual(recordingSteps("api-first", false, true), ["api"]);
    assert.deepEqual(recordingSteps("local", false, true), [], "local never sends audio out");
});

await check("the limits agree: a 3-minute piece, the routes' body limits, 5 minutes and the capture size", () => {
    assert.equal(limits.RECORDING_PIECE_BYTES, 5_760_000);
    assert.equal(RECORDING_PIECE_BODY_LIMIT, limits.RECORDING_PIECE_BYTES);
    assert.equal(bodyLimit("/api/capture/transcribe-piece"), RECORDING_PIECE_BODY_LIMIT);
    assert.equal(bodyLimit("/api/capture/recording"), RECORDING_SUMMARY_BODY_LIMIT);
    assert.ok(RECORDING_PIECE_BODY_LIMIT < NEXT_BODY_LIMIT && RECORDING_SUMMARY_BODY_LIMIT > limits.CAPTURE_TEXT_MAX * 3);
    assert.equal(limits.LONG_AUDIO_SECONDS, VOICE_NOTE_MAX_SECONDS);
    assert.equal(limits.CAPTURE_TEXT_MAX, SOURCE_TEXT_MAX);
    assert.equal(limits.durationLabel(400), "7 min");
    assert.equal(limits.durationLabel(20), "20 s");
});

await check("the browser mixes any rate down to 16 kHz mono and cuts 3-minute pieces in order", () => {
    const left = new Float32Array(48000).fill(0.5), right = new Float32Array(48000).fill(-0.1);
    const mixed = mixToPcm([left, right], 48000);
    assert.equal(mixed.length, 16000);
    assert.ok(Math.abs(mixed[100] - 0.2 * 0x7fff) <= 1, `mixed ${mixed[100]}`);
    assert.equal(mixToPcm([new Float32Array(8000).fill(1)], 8000).length, 16000, "8 kHz phone audio is stretched, not dropped");
    assert.equal(mixToPcm([new Float32Array(10).fill(3)], 16000)[0], 0x7fff, "clipped, not wrapped");

    const pcm = new Int16Array(7 * 60 * 16000);
    for (let index = 0; index < pcm.length; index++) pcm[index] = Math.floor(index / (180 * 16000));
    const recording = recordingFromPcm(pcm);
    assert.equal(recording.pieces, 3);
    assert.equal(recording.seconds, 420);
    const sizes = [0, 1, 2].map((index) => recording.piece(index).byteLength);
    assert.deepEqual(sizes, [5_760_000, 5_760_000, 1_920_000]);
    for (const index of [0, 1, 2]) assert.equal(new Int16Array(recording.piece(index).buffer)[0], index, `piece ${index} starts where it should`);
});

await check("pieces go one at a time, in order, and a busy server is retried", async () => {
    const recording = recordingFromPcm(new Int16Array(7 * 60 * 16000));
    const replies = [new Response(JSON.stringify({ error: "busy" }), { status: 503 }), Response.json({ text: "one", model: "whisper-large-v3-turbo" }),
        Response.json({ text: "", model: null }), Response.json({ text: "three", model: "moonshine-tiny-en" })];
    const sent: number[] = [], waits: number[] = [], progress: number[] = [];
    const result = await transcribeRecording(recording, { signal: new AbortController().signal, onProgress: (done) => progress.push(done),
        send: async (piece) => { sent.push(piece.byteLength); return replies.shift()!; }, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(result, { text: "one three", done: 3, total: 3, models: ["whisper-large-v3-turbo", "moonshine-tiny-en"], stopped: false });
    assert.deepEqual(sent, [5_760_000, 5_760_000, 5_760_000, 1_920_000]);
    assert.deepEqual(waits, [2_000]);
    assert.deepEqual(progress, [0, 1, 2]);
});

await check("a refused or failing piece keeps the text so far; Stop does too; a signed-out page throws", async () => {
    const recording = recordingFromPcm(new Int16Array(7 * 60 * 16000));
    const run = (replies: (() => Response)[], controller = new AbortController()) => {
        const waits: number[] = [];
        return transcribeRecording(recording, { signal: controller.signal, send: async () => replies.shift()!(), wait: async (ms) => { waits.push(ms); } })
            .then((result) => ({ result, waits }));
    };
    const refused = await run([() => Response.json({ text: "first" }), () => Response.json({ error: "A piece holds at most 3 minutes of audio." }, { status: 413 })]);
    assert.equal(refused.result.text, "first");
    assert.equal(refused.result.done, 1);
    assert.equal(refused.result.failed, "A piece holds at most 3 minutes of audio.");
    assert.deepEqual(refused.waits, [], "a refusal is not retried");

    const busy = () => Response.json({ error: "The transcription model is busy." }, { status: 429 });
    const failing = await run([() => Response.json({ text: "first" }), busy, busy, busy]);
    assert.equal(failing.result.failed, "The transcription model is busy.");
    assert.deepEqual(failing.waits, [2_000, 5_000], "three tries in all");

    const controller = new AbortController();
    const stopped = await run([() => { controller.abort(); return Response.json({ text: "first" }); }], controller);
    assert.deepEqual({ text: stopped.result.text, done: stopped.result.done, stopped: stopped.result.stopped }, { text: "first", done: 1, stopped: true });

    await assert.rejects(run([() => Response.json({ error: "Unauthorized" }, { status: 401 })]), /Sign in again/);
});

await check("the capture body is the summary, then the transcript, cut to what a capture holds", () => {
    assert.deepEqual(recordingBody("It covered retrieval.", "words"), { text: "It covered retrieval.\n\n## Transcript\n\nwords", cut: false });
    assert.deepEqual(recordingBody(null, "words"), { text: "words", cut: false });
    const long = recordingBody("Summary.", "x".repeat(200_000));
    assert.equal(long.text.length, limits.CAPTURE_TEXT_MAX);
    assert.equal(long.cut, true);
    assert.deepEqual(parseRecordingSummary(JSON.stringify({ title: "  Week\n3  ", summary: "Points." })), { title: "Week 3", summary: "Points." });
    assert.throws(() => parseRecordingSummary(JSON.stringify({ title: "", summary: "Points." })));
});

await check("audio formats come from the extension first, then the type, and each route has a size cap", () => {
    assert.equal(audioFormat("voice.ogg", "audio/ogg")?.ext, "ogg");
    assert.equal(audioFormat("voice-message.ogg", "application/octet-stream")?.ext, "ogg");
    assert.deepEqual(audioFormat("Lecture.m4a", "audio/x-m4a"), { ext: "m4a", mime: "audio/mp4", gemini: "audio/aac" });
    assert.equal(audioFormat("audio", "audio/mpeg")?.ext, "mp3");
    assert.equal(audioFormat("clip.webm", "")?.gemini, null);
    assert.equal(audioFormat("notes.txt", "text/plain"), null);
    const groq = { provider: { id: "groq", kind: "openai-compatible" as const, baseUrl: "https://api.groq.com/openai/v1" }, modelId: "whisper-large-v3-turbo", apiKey: "k" };
    const gemini = { provider: { id: "gemini-free", kind: "gemini" as const, baseUrl: "" }, modelId: "gemini-3.5-transcribe", apiKey: "k" };
    assert.equal(apiAudioLimit(groq), 24 * 1024 * 1024);
    assert.equal(apiAudioLimit(gemini), 14 * 1024 * 1024, "base64 plus the request stays under Gemini's 20 MB");
});

await check("Ogg Opus length comes from the last page, without decoding", () => {
    const seconds = oggOpusSeconds(fixture);
    assert.ok(seconds !== null && seconds > 4.3 && seconds < 5.1, `read ${seconds} s`);
    assert.equal(oggOpusSeconds(fakeOpus(400)), 400);
    assert.equal(oggOpusSeconds(new TextEncoder().encode("not audio at all, not even close to it")), null);
    assert.equal(oggOpusSeconds(fakeOpus(10).subarray(0, 20)), null);
});

await check("a piece goes to the API model first and falls back to the box in 30-second slices, in order", async () => {
    const slices: number[] = [];
    const local = async (pcm: Uint8Array<ArrayBuffer>) => { slices.push(pcm.byteLength); return { ok: true as const, text: `part${slices.length}`, audioSec: 30, decodeMs: 1, model: "moonshine-tiny-en" }; };
    const apiRoute = { provider: { id: "groq", kind: "openai-compatible" as const, baseUrl: "https://api.groq.com/openai/v1" }, modelId: "whisper-large-v3-turbo", apiKey: "k" };
    let apiTimeout = 0;
    const busyApi = async (_route: unknown, _wav: Buffer, options?: { timeoutMs?: number }) => { apiTimeout = options?.timeoutMs ?? 0; return { ok: false as const, status: 429, error: "busy", transient: true, retiredAt: null, ms: 5 }; };
    const result = await transcribeRecordingPiece(pcmBytes(180), { steps: ["api", "local"], apiRoute, api: busyApi, local });
    assert.equal(apiTimeout, 40_000, "a 3-minute piece gets longer than a voice turn's 15 s");
    assert.deepEqual(slices, Array(6).fill(960_000));
    assert.deepEqual(result, { ok: true, text: "part1 part2 part3 part4 part5 part6", audioSec: 180, engine: "local", model: "moonshine-tiny-en" });

    slices.length = 0;
    const okApi = async () => ({ ok: true as const, text: "api words", ms: 900 });
    assert.equal((await transcribeRecordingPiece(pcmBytes(180), { steps: ["api", "local"], apiRoute, api: okApi, local })).ok, true);
    assert.equal(slices.length, 0, "the box is not asked when the API answered");
    const silentApi = async () => ({ ok: true as const, text: "  ", ms: 900 });
    assert.deepEqual(await transcribeRecordingPiece(pcmBytes(180), { steps: ["api", "local"], apiRoute, api: silentApi, local }), { ok: false, reason: "empty" });
    assert.equal(slices.length, 0, "silence is final");
});

await check("the box fallback stops before Cloudflare's 100-second cut", async () => {
    let clock = 0;
    const local = async () => { clock += 20_000; return { ok: true as const, text: "slow", audioSec: 30, decodeMs: 1, model: "moonshine-tiny-en" }; };
    const result = await transcribeRecordingPiece(pcmBytes(180), { steps: ["local"], apiRoute: null, local, now: () => clock });
    assert.deepEqual(result, { ok: false, reason: "timeout" });
    assert.equal(clock, 80_000, "four slices fit; a fifth could run past the cut");
});

await check("a long file goes to the API model whole, compressed, with its own name and type", async () => {
    const result = await transcribeLongAudio({ bytes: fakeOpus(400), name: "voice-message.ogg", mimeType: "audio/ogg" }, { choice: choice("api-first"), freeOnly: true });
    assert.deepEqual(result, { ok: true, text: "api words", model: "whisper-large-v3-turbo" });
    const call = seen.find(({ url }) => url.hostname === "api.groq.com")!;
    assert.equal(call.url.pathname, "/openai/v1/audio/transcriptions");
    const form = formOf(call)!;
    const file = form.get("file") as File;
    assert.equal(file.name, "audio.ogg");
    assert.equal(file.type, "audio/ogg");
    assert.equal(file.size, fakeOpus(400).length, "the bytes are sent as they came, not decoded");
    assert.equal(form.get("model"), "whisper-large-v3-turbo");

    seen.length = 0;
    const gemini = { provider: { id: "gemini-free", kind: "gemini" as const, baseUrl: "" }, modelId: "gemini-3.5-transcribe", apiKey: "k" };
    geminiReply = () => Response.json({ candidates: [{ content: { parts: [{ text: "gemini words" }] } }] });
    const heard = await transcribeAudioWithApi(gemini, Buffer.from("m4a bytes"), audioFormat("Lecture.m4a", "audio/mp4")!);
    assert.deepEqual({ ok: heard.ok, text: heard.ok ? heard.text : "" }, { ok: true, text: "gemini words" });
    const sent = JSON.parse(String(seen.find(({ url }) => url.hostname === "generativelanguage.googleapis.com")!.body));
    assert.equal(sent.contents[0].parts[0].inlineData.mimeType, "audio/aac");
});

await check("long audio needs an API model the owner allows, a format it takes and a size it accepts", async () => {
    const file = (bytes: Uint8Array, name = "voice.ogg", mimeType = "audio/ogg") => ({ bytes, name, mimeType });
    assert.deepEqual(await transcribeLongAudio(file(fakeOpus(400)), { choice: choice("local"), freeOnly: false }), { ok: false, reason: "no_model" });
    assert.deepEqual(await transcribeLongAudio(file(fakeOpus(400)), { choice: choice("api", "groq", "paid-ears"), freeOnly: true }), { ok: false, reason: "no_model" }, "Free only keeps a paid model out");
    assert.deepEqual(await transcribeLongAudio(file(fakeOpus(400), "clip.webm", "audio/webm"), { choice: choice("api", "gemini-free", "gemini-3.5-transcribe"), freeOnly: true }), { ok: false, reason: "unsupported" });
    assert.deepEqual(await transcribeLongAudio(file(new Uint8Array(15 * 1024 * 1024)), { choice: choice("api", "gemini-free", "gemini-3.5-transcribe"), freeOnly: true }), { ok: false, reason: "too_large" });
    groqReply = () => Response.json({ error: { message: "Rate limit reached for audio seconds per hour" } }, { status: 429 });
    try {
        assert.deepEqual(await transcribeLongAudio(file(fakeOpus(400)), { choice: choice("api"), freeOnly: true }), { ok: false, reason: "busy" });
    } finally { groqReply = () => Response.json({ text: "api words" }); }
    assert.equal(longAudioFailureText("no_model"), "Too long to transcribe right now: no API transcription model is chosen and approved on /admin.");
    assert.equal(longAudioFailureText("empty"), "No speech was heard in that recording.");
});

const cookie = `${AUTH_COOKIE}=${await createSessionValue()}`;
const piece = (body: Uint8Array, headers: Record<string, string> = { cookie, "content-type": "application/octet-stream" }) =>
    pieceRoute.POST(new NextRequest("https://assistant.test/api/capture/transcribe-piece", { method: "POST", headers, body: body as BodyInit }));
const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });

await check("piece route: session only, raw PCM up to 3 minutes, the owner's order, sizes logged without words", async () => {
    useChoice(choice("local"));
    assert.equal((await piece(pcmBytes(1), { "content-type": "application/octet-stream" })).status, 401);
    assert.equal((await piece(pcmBytes(1), { cookie, origin: "https://evil.test", "content-type": "application/octet-stream" })).status, 403);
    assert.equal((await piece(pcmBytes(1), { cookie, "content-type": "audio/wav" })).status, 415);
    assert.equal((await piece(new Uint8Array(5_760_002))).status, 413);
    assert.equal((await piece(new Uint8Array(3))).status, 400);
    assert.equal(seen.filter(({ url }) => url.hostname === "stt.test").length, 0, "rejected pieces reach no service");

    sttReply = () => Response.json({ text: "PRIVATE BOX WORDS", audioSec: 30, decodeMs: 5, model: "moonshine-tiny-en" });
    const local = await json(await piece(pcmBytes(180)));
    assert.equal(local.status, 200);
    assert.equal(local.body.engine, "local");
    assert.equal(local.body.seconds, 180);
    assert.equal(seen.filter(({ url }) => url.hostname === "stt.test").length, 6, "the box hears six 30-second slices");
    assert.equal(seen.filter(({ url }) => url.hostname === "api.groq.com").length, 0, "local order never sends audio out");

    useChoice(choice("api-first"));
    seen.length = 0;
    groqReply = () => Response.json({ text: "PRIVATE API WORDS" });
    const api = await json(await piece(pcmBytes(180)));
    assert.deepEqual(api.body, { text: "PRIVATE API WORDS", engine: "api", model: "whisper-large-v3-turbo", seconds: 180 });
    assert.equal((formOf(seen.find(({ url }) => url.hostname === "api.groq.com")!)!.get("file") as File).name, "audio.wav");
    assert.ok(logs.some((line) => line.includes("\"recording_piece\"")), "each piece is logged");
    assert.ok(!logs.some((line) => line.includes("PRIVATE")), "logs never hold the words");

    groqReply = () => Response.json({ text: "  " });
    assert.deepEqual((await json(await piece(pcmBytes(10)))).body, { text: "", engine: null, model: null, seconds: 10 }, "silence is an empty piece, not an error");
    groqReply = () => Response.json({ text: "api words" });

    useChoice(choice("local"));
    const url = process.env.STT_SERVICE_URL;
    delete process.env.STT_SERVICE_URL;
    try {
        const none = await json(await piece(pcmBytes(10)));
        assert.equal(none.status, 503);
        assert.match(String(none.body.error), /Choose and approve an API transcription model/);
    } finally { process.env.STT_SERVICE_URL = url; }
});

await check("recording route: a title and summary from a transcript, nothing stored", async () => {
    const post = (body: unknown, headers: Record<string, string> = { cookie, "content-type": "application/json" }) =>
        recordingRoute.POST(new NextRequest("https://assistant.test/api/capture/recording", { method: "POST", headers, body: JSON.stringify(body) }));
    assert.equal((await post({ name: "a.m4a", seconds: 60, transcript: "words" }, { "content-type": "application/json" })).status, 401);
    assert.equal((await post({ name: "a.m4a", seconds: 60, transcript: "" })).status, 400);
    assert.equal((await post({ name: "a.m4a", seconds: 60, transcript: "x".repeat(120_001) })).status, 400);
    geminiReply = () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "Week 3 lecture", summary: "It covered retrieval.\n\n- Rerank before reading" }) }] }, finishReason: "STOP" }] });
    const written = await json(await post({ name: "lecture.m4a", seconds: 2820, transcript: "Today we cover retrieval." }));
    assert.equal(written.status, 200);
    assert.equal(written.body.title, "Week 3 lecture");
    assert.match(String(written.body.summary), /Rerank before reading/);
    assert.match(String(written.body.model), /^gemini\//);
    const prompt = JSON.parse(String(seen.find(({ url }) => url.hostname === "generativelanguage.googleapis.com")!.body)).contents[0].parts[0].text as string;
    assert.match(prompt, /about 47 minutes/);
    assert.equal(seen.filter(({ url }) => url.pathname.endsWith("/capture_inbox")).length, 0);
    geminiReply = () => Response.json({ error: { message: "overloaded" } }, { status: 400 });
    assert.equal((await post({ name: "lecture.m4a", seconds: 60, transcript: "words" })).status, 502);
});

await check("Telegram: voice notes and audio files over 5 minutes are recordings; shorter ones stay chat turns", () => {
    assert.equal(longRecording({ voice: { file_id: "v", duration: 300 } }), null);
    assert.equal(longRecording({ audio: { file_id: "a", duration: 120, file_name: "song.mp3" } }), null);
    assert.deepEqual(longRecording({ voice: { file_id: "v", duration: 400, file_size: 900_000 }, date: 1764000000 }),
        { fileId: "v", fileSize: 900_000, seconds: 400, name: "voice.ogg", mimeType: "audio/ogg", title: "Voice note 25/11/2025" });
    assert.deepEqual(longRecording({ audio: { file_id: "a", duration: 2820, file_name: "week_3-lecture.m4a", mime_type: "audio/x-m4a" } }),
        { fileId: "a", fileSize: 0, seconds: 2820, name: "week_3-lecture.m4a", mimeType: "audio/x-m4a", title: "week 3 lecture" });
    assert.equal(recordingTitle({ title: "Board meeting\nnotes", fileName: "rec.m4a" }), "Board meeting notes");
});

await check("Telegram: the transcript heading reads back, and each message has one stable capture id", () => {
    const text = `${transcriptHeading("week 3 lecture", 2820)}\n\nToday we cover retrieval.\nThen reranking.`;
    assert.equal(text.split("\n")[0], "Transcript: week 3 lecture (47 min)");
    assert.deepEqual(parseTranscriptMessage(text), { title: "week 3 lecture", text: "Today we cover retrieval.\nThen reranking." });
    assert.equal(parseTranscriptMessage("Just a reply\n\nwith text"), null);
    const id = transcriptCaptureId(1001, 77);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(transcriptCaptureId(1001, 77), id);
    assert.notEqual(transcriptCaptureId(1001, 78), id);
});

const telegramUpdate = (updateId: number, message: Record<string, unknown>) => new NextRequest("https://assistant.test/api/telegram/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "fixture-webhook-secret" },
    body: JSON.stringify({ update_id: updateId, ...message }),
});
const longVoice = (updateId: number) => telegramUpdate(updateId, { message: { message_id: 3, date: 1764000000, chat: { id: 1001 }, from: { id: 1001 }, voice: { file_id: "voice-long", duration: 400, file_size: fixture.length } } });

await check("Telegram webhook: a long voice note gets Transcribing, then the transcript with Save to Capture, and no chat turn", async () => {
    useChoice(choice("api-first"));
    await webhook.POST(longVoice(401));
    const sends = telegramSends("sendMessage").map(sentText);
    assert.equal(sends.length, 2);
    assert.equal(sends[0].text, "Transcribing 7 min of audio. I will send it when done.");
    assert.equal(sends[1].text, "Transcript: Voice note 25/11/2025 (7 min)\n\napi words");
    assert.equal(sends[1].reply_markup?.inline_keyboard[0][0].callback_data, "cap:save");
    assert.equal((formOf(seen.find(({ url }) => url.hostname === "api.groq.com")!)!.get("file") as File).name, "audio.ogg");
    assert.equal(seen.filter(({ url }) => url.hostname === "stt.test").length, 0, "the box never decodes a long note");
    assert.equal(savedMessages().length, 0, "a recording is not a chat turn");
    assert.ok(logs.some((line) => line.includes("\"telegram_long_audio\"")) && !logs.some((line) => line.includes("api words")));

    seen.length = 0;
    groqReply = () => Response.json({ text: "word ".repeat(900).trim() });
    try { await webhook.POST(longVoice(402)); } finally { groqReply = () => Response.json({ text: "api words" }); }
    const document = telegramSends("sendDocument");
    assert.equal(document.length, 1, "a long transcript goes as a text file");
    const form = formOf(document[0])!;
    assert.equal((form.get("document") as File).name, "Voice note 25_11_2025 transcript.txt");
    assert.equal(JSON.parse(String(form.get("reply_markup"))).inline_keyboard[0][0].callback_data, "cap:save");
    assert.match(String(form.get("caption")), /^Transcript: Voice note 25\/11\/2025 \(7 min\)\. The full text is attached\.$/);
});

await check("Telegram webhook: with no API model, long audio is turned down before anything downloads", async () => {
    useChoice(choice("local"));
    await webhook.POST(longVoice(403));
    const sends = telegramSends("sendMessage").map(sentText);
    assert.deepEqual(sends.map(({ text }) => text), ["Too long to transcribe right now: no API transcription model is chosen and approved on /admin."]);
    assert.equal(telegramSends("getFile").length, 0);
    assert.equal(savedMessages().length, 0);

    seen.length = 0;
    useChoice(choice("api-first"));
    await webhook.POST(telegramUpdate(404, { message: { message_id: 4, chat: { id: 1001 }, from: { id: 1001 }, voice: { file_id: "voice-big", duration: 4000, file_size: 21 * 1024 * 1024 } } }));
    assert.match(telegramSends("sendMessage").map(sentText)[0].text, /over 20 MB/);
    assert.equal(telegramSends("getFile").length, 0);
});

await check("Telegram: Save to Capture stores the transcript once and swaps the button for a review link", async () => {
    captureRows.clear();
    const tap = (updateId: number, message: Record<string, unknown>) => webhook.POST(telegramUpdate(updateId,
        { callback_query: { id: `cb-${updateId}`, from: { id: 1001 }, data: "cap:save", message: { message_id: 77, chat: { id: 1001 }, ...message } } }));
    await tap(405, { text: "Transcript: week 3 lecture (47 min)\n\nToday we cover retrieval." });
    const id = transcriptCaptureId(1001, 77);
    const row = captureRows.get(id)!;
    assert.deepEqual(row.source, { kind: "text", title: "week 3 lecture", text: "Today we cover retrieval." });
    assert.equal(row.profile_id, OWNER);
    assert.equal(sentText(telegramSends("answerCallbackQuery")[0]).text, "Saved to Capture for review.");
    const markup = sentText(telegramSends("editMessageReplyMarkup")[0]).reply_markup!;
    assert.equal(markup.inline_keyboard[0][0].url, `https://assistant.test/capture?review=${id}`);

    seen.length = 0;
    await tap(406, { text: "Transcript: week 3 lecture (47 min)\n\nToday we cover retrieval." });
    assert.equal(captureRows.size, 1, "a second tap finds the same capture");
    assert.equal(sentText(telegramSends("answerCallbackQuery")[0]).text, "Saved to Capture for review.");

    seen.length = 0;
    captureRows.clear();
    telegramFile = new TextEncoder().encode("Transcript: Voice note 25/11/2025 (7 min)\n\nFrom the attached file.\n");
    try { await tap(407, { document: { file_id: "doc-1", file_name: "Voice note transcript.txt" }, caption: "Transcript: Voice note 25/11/2025 (7 min). The full text is attached." }); }
    finally { telegramFile = fixture; }
    assert.deepEqual(captureRows.get(id)!.source, { kind: "text", title: "Voice note 25/11/2025", text: "From the attached file." });

    seen.length = 0;
    await tap(408, { text: "Some other reply" });
    assert.equal(sentText(telegramSends("answerCallbackQuery")[0]).text, "This transcript could not be read. Send the recording again.");
});

const discordChat = (file: Uint8Array, message = "[Sent voice-message.ogg]") => chatRoute.POST(new NextRequest("https://assistant.test/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer fixture-chat" },
    body: JSON.stringify({ message, channel: "discord", file: { name: "voice-message.ogg", mimeType: "audio/ogg", base64: Buffer.from(file).toString("base64"), size: file.length } }),
}));

await check("Discord: a voice message's transcript becomes the message, marked as spoken", async () => {
    assert.equal(isDiscordVoice({ mimeType: "audio/ogg" }), true);
    assert.equal(isDiscordVoice({ mimeType: "audio/mpeg" }), false);
    assert.equal(botPlaceholder("[Sent voice-message.ogg]", { name: "voice-message.ogg" }), true);
    useChoice(choice("local"));
    sttReply = () => Response.json({ text: "please add milk eggs and bread", audioSec: 4.7, decodeMs: 300, model: "moonshine-tiny-en" });
    await discordChat(fixture).catch(() => null);
    const users = savedMessages().filter((row) => row.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0].content, "please add milk eggs and bread", "the bot's stand-in text is replaced");
    assert.equal(users[0].metadata?.inputMode, "voice");
    assert.equal(users[0].channel, "discord");

    seen.length = 0;
    await discordChat(fixture, "what do you think?").catch(() => null);
    assert.equal(savedMessages().filter((row) => row.role === "user")[0].content, "what do you think?\n\nplease add milk eggs and bread", "typed text stays first");
});

await check("Discord: over 5 minutes, the reply is the transcript, attached when long, with no chat turn", async () => {
    useChoice(choice("api-first"));
    const short = await json(await discordChat(fakeOpus(400)));
    assert.equal(short.status, 200);
    assert.equal(short.body.reply, "**Transcript of voice-message.ogg (7 min)**\n\napi words");
    assert.deepEqual(short.body.artifacts, []);
    assert.equal(savedMessages().length, 0);
    assert.equal(seen.filter(({ url }) => url.hostname === "stt.test").length, 0, "the length came from the Ogg pages, nothing was decoded");

    groqReply = () => Response.json({ text: "spoken words here ".repeat(200).trim() });
    try {
        const long = await json(await discordChat(fakeOpus(1500)));
        assert.match(String(long.body.reply), /^\*\*Transcript of voice-message\.ogg \(25 min\)\*\*\n\nspoken words/);
        assert.match(String(long.body.reply), /The full transcript is attached\.$/);
        const [artifact] = long.body.artifacts as { name: string; base64: string }[];
        assert.equal(artifact.name, "transcript.txt");
        assert.match(Buffer.from(artifact.base64, "base64").toString("utf-8"), /^Transcript of voice-message\.ogg \(25 min\)\n\nspoken words/);
    } finally { groqReply = () => Response.json({ text: "api words" }); }

    useChoice(choice("local"));
    const refused = await json(await discordChat(fakeOpus(400)));
    assert.equal(refused.body.reply, "Too long to transcribe right now: no API transcription model is chosen and approved on /admin.");
    assert.equal(transcriptReply("a.ogg", null, "words").reply, "**Transcript of a.ogg**\n\nwords");
});

await check("Discord: a failure other than length leaves the audio for the chat model", async () => {
    useChoice(choice("local"));
    const file = { name: "voice-message.ogg", mimeType: "audio/ogg", base64: Buffer.from(fixture).toString("base64"), size: fixture.length };
    assert.deepEqual(await discordVoice(file, false, undefined, { voiceNote: async () => ({ ok: false, reason: "busy" }) }), { kind: "audio" });
    assert.deepEqual(await discordVoice(file, false, undefined, { voiceNote: async () => { throw new Error("wasm"); } }), { kind: "audio" });
    let longCalled = false;
    const tooLong = await discordVoice(file, false, undefined, { voiceNote: async () => ({ ok: false, reason: "too_long" }), longAudio: async () => { longCalled = true; return { ok: true, text: "long words", model: "m" }; } });
    assert.equal(longCalled, true, "a note the decoder finds too long takes the long path");
    assert.equal(tooLong.kind, "reply");
});

console.log = log;
console.log(`Long audio: ${passed} checks passed; all network transport was mocked.`);
