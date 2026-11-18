import assert from "node:assert/strict";
import { STT_MAX_BYTES, sttAvailable, sttConfigured, transcribePcm } from "../src/lib/voice/stt-client";
import { inputModeError, userMessageMetadata, VOICE_TRANSCRIPT_NOTE } from "../src/lib/voice/input-mode";
import { floatToPcm16, resampledLength } from "../src/app/home/voice-pcm";

const env = { STT_SERVICE_URL: "http://127.0.0.1:3010/", STT_SERVICE_TOKEN: "fixture-token" };
const pcm = new Uint8Array(32000);
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

assert.equal(sttConfigured({}), false);
assert.equal(sttConfigured({ STT_SERVICE_URL: "http://127.0.0.1:3010" }), false);
assert.equal(sttConfigured(env), true);

const never = stub(() => { throw new Error("must not be called"); });
assert.deepEqual(await transcribePcm(pcm, { env: {}, fetchImpl: never.fetchImpl }), { ok: false, reason: "unconfigured" });
assert.deepEqual(await transcribePcm(new Uint8Array(STT_MAX_BYTES + 2), { env, fetchImpl: never.fetchImpl }), { ok: false, reason: "too_large" });
assert.equal(never.seen.length, 0);

const ok = stub(() => Response.json({ text: "  remind me to call the bank  ", audioSec: 1, decodeMs: 120, model: "moonshine-tiny-en" }));
assert.deepEqual(await transcribePcm(pcm, { env, fetchImpl: ok.fetchImpl }),
    { ok: true, text: "remind me to call the bank", audioSec: 1, decodeMs: 120, model: "moonshine-tiny-en" });
const sent = ok.seen[0];
assert.equal(sent.url, "http://127.0.0.1:3010/transcribe");
const headers = new Headers(sent.init?.headers);
assert.equal(headers.get("authorization"), "Bearer fixture-token");
assert.equal(headers.get("content-type"), "application/octet-stream");
assert.equal(headers.get("x-sample-rate"), "16000");
assert.equal(sent.init?.body, pcm);

const status = async (code: number, body: unknown) => (await transcribePcm(pcm, { env, fetchImpl: stub(() => Response.json(body, { status: code })).fetchImpl }));
assert.deepEqual(await status(200, { text: "   " }), { ok: false, reason: "empty" });
assert.deepEqual(await status(503, { error: "busy" }), { ok: false, reason: "busy" });
assert.deepEqual(await status(503, { error: "timeout" }), { ok: false, reason: "timeout" });
assert.deepEqual(await status(503, { error: "loading" }), { ok: false, reason: "unavailable" });
assert.deepEqual(await status(413, { error: "too_large" }), { ok: false, reason: "too_large" });
assert.deepEqual(await status(401, { error: "unauthorised" }), { ok: false, reason: "error" });
assert.deepEqual(await status(500, { error: "decode_failed" }), { ok: false, reason: "error" });
// Node's fetch throws on a 401 with a body; a refused connection throws too.
assert.deepEqual(await transcribePcm(pcm, { env, fetchImpl: stub(() => { throw new TypeError("fetch failed"); }).fetchImpl }), { ok: false, reason: "unavailable" });
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(transcribePcm(pcm, { env, signal: cancelled.signal, fetchImpl: stub(() => { throw new DOMException("cancelled", "AbortError"); }).fetchImpl }), { name: "AbortError" });

assert.equal(await sttAvailable({ env, fetchImpl: stub(() => Response.json({ ok: true, loaded: true })).fetchImpl }), true);
assert.equal(await sttAvailable({ env, fetchImpl: stub(() => Response.json({ ok: true, loaded: false })).fetchImpl }), false);
assert.equal(await sttAvailable({ env, fetchImpl: stub(() => new Response("down", { status: 502 })).fetchImpl }), false);
assert.equal(await sttAvailable({ env, fetchImpl: stub(() => { throw new TypeError("fetch failed"); }).fetchImpl }), false);
assert.equal(await sttAvailable({ env: {}, fetchImpl: never.fetchImpl }), false);

assert.equal(inputModeError(undefined), null);
assert.equal(inputModeError("voice"), null);
assert.match(inputModeError("typing") ?? "", /Input mode/);
assert.match(inputModeError(true) ?? "", /Input mode/);
assert.equal(userMessageMetadata(undefined, undefined), undefined);
assert.deepEqual(userMessageMetadata(undefined, "voice"), { inputMode: "voice" });
const quote = { role: "assistant" as const, content: "Earlier" };
assert.deepEqual(userMessageMetadata(quote, undefined), { replyTo: quote });
assert.deepEqual(userMessageMetadata(quote, "voice"), { replyTo: quote, inputMode: "voice" });
assert.match(VOICE_TRANSCRIPT_NOTE, /speech-to-text transcript/);

assert.deepEqual([...floatToPcm16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]))], [-32768, -32768, -16384, 0, 16383, 32767, 32767]);
assert.equal(resampledLength(1.5), 24000);
assert.equal(resampledLength(0), 1);
assert.equal(resampledLength(0.00001), 1);

console.log("Voice STT client: config, request shape, every failure mapped to a fallback, health, input mode and PCM helpers passed offline.");
