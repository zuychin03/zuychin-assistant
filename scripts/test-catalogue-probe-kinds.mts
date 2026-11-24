import assert from "node:assert/strict";
import { probeEmbedding, PROBE_PASSAGES, PROBE_QUERIES } from "../src/lib/ai/catalogue/probe-embedding";
import { probeSpeech } from "../src/lib/ai/catalogue/probe-speech";
import { probeClip, probeTranscription } from "../src/lib/ai/catalogue/probe-transcription";
import { errorDetail, retiredAtFrom } from "../src/lib/ai/embedding-request";
import { parseWav, pcmToWav } from "../src/lib/voice/audio";
import { wordAccuracy } from "../src/lib/voice/api-stt";

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const nim = { id: "nvidia-nim", kind: "openai-compatible" as const, baseUrl: "https://nim.invalid/v1" };
const openrouter = { id: "openrouter", kind: "openai-compatible" as const, baseUrl: "https://openrouter.invalid/api/v1" };
const groq = { id: "groq", kind: "openai-compatible" as const, baseUrl: "https://groq.invalid/openai/v1" };
const gemini = { id: "gemini-free", kind: "gemini" as const };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// A bag-of-words embedder: long words hash into buckets, and a query adds weight to bucket 0, so the two forms differ.
function bucket(word: string, salt: number): number {
    let hash = salt;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return 1 + (hash % 1023);
}
function fakeVector(text: string, inputType: string | undefined, salt = 7, dimension = 1024): number[] {
    const out = new Array<number>(1024).fill(0);
    for (const word of text.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/)) if (word.length > 3) out[bucket(word, salt)] += 1;
    if (inputType === "query") out[0] += 0.5;
    return out.slice(0, dimension);
}

interface EmbedFake { requireInputType?: boolean; refuseInputType?: boolean; status?: number; detail?: string; noBatch?: boolean; salt?: number }
function embedFetch(fake: EmbedFake, calls: Record<string, unknown>[] = []): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push(body);
        if (fake.status) return json(fake.status, { detail: fake.detail ?? "error" });
        if (fake.requireInputType && body.input_type === undefined) return json(400, { message: "'input_type' parameter is required for asymmetric models" });
        if (fake.refuseInputType && body.input_type !== undefined) return json(400, { error: { message: "Unrecognized request argument supplied: input_type" } });
        const inputs = Array.isArray(body.input) ? body.input as string[] : [body.input as string];
        if (fake.noBatch && inputs.length > 1) return json(400, { error: { message: "input must be a string" } });
        const inputType = fake.refuseInputType ? "query" : body.input_type as string | undefined;
        const dimension = typeof body.dimensions === "number" ? body.dimensions : 1024;
        return json(200, { data: inputs.map((text, index) => ({ index, embedding: fakeVector(text, inputType, fake.salt, dimension) })) });
    }) as typeof fetch;
}
const embedTarget = { provider: nim, modelId: "vendor/embed-1b", apiKey: "fixture-key" };

await check("embedding: a full pass records dimension, input type, asymmetry, truncation and batch", async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await probeEmbedding(embedTarget, { fetchImpl: embedFetch({ requireInputType: true }, calls) });
    assert.equal(result.status, "passed");
    assert.equal(result.dimension, 1024);
    assert.deepEqual(result.traits, { needsInputType: true, acceptsInputType: true, asymmetric: true, truncatable: true, batch: true });
    assert.equal(result.steps.space?.outcome, "skipped");
    assert.equal(result.vectors?.passages.length, PROBE_PASSAGES.length);
    assert.equal(result.vectors?.queries.length, PROBE_QUERIES.length);
    assert.equal(calls.filter((call) => call.input_type === undefined).length, 1, "only the first call goes without input_type");
});

await check("embedding: a route that refuses input_type is embedded without it", async () => {
    const result = await probeEmbedding(embedTarget, { fetchImpl: embedFetch({ refuseInputType: true, noBatch: true }) });
    assert.equal(result.status, "passed");
    assert.equal(result.traits.acceptsInputType, false);
    assert.equal(result.traits.asymmetric, false);
    assert.equal(result.traits.batch, false);
});

await check("embedding: same vectors prove the same space, other vectors do not", async () => {
    const reference = (await probeEmbedding(embedTarget, { fetchImpl: embedFetch({ requireInputType: true }) })).vectors!;
    const same = await probeEmbedding({ ...embedTarget, provider: openrouter, modelId: "vendor/embed-1b:free", reference: { partitionId: "vendor/embed-1b", ...reference } }, { fetchImpl: embedFetch({}) });
    assert.equal(same.spaceOf, "vendor/embed-1b");
    assert.equal(same.steps.space?.outcome, "pass");
    const other = await probeEmbedding({ ...embedTarget, reference: { partitionId: "vendor/embed-1b", ...reference } }, { fetchImpl: embedFetch({ salt: 11 }) });
    assert.equal(other.status, "passed");
    assert.equal(other.spaceOf, null);
    assert.equal(other.steps.space?.outcome, "fail");
});

await check("embedding: 410 is retired with its date, 404 is not callable, 503 is inconclusive", async () => {
    const gone = await probeEmbedding(embedTarget, { fetchImpl: embedFetch({ status: 410, detail: "The model 'vendor/embed-1b' has reached its end of life on 2026-11-23T09:00:00Z and is no longer available." }) });
    assert.equal(gone.status, "failed");
    assert.equal(gone.retired, true);
    assert.equal(gone.retiredAt, "2026-11-23T09:00:00.000Z");
    const missing = await probeEmbedding(embedTarget, { fetchImpl: embedFetch({ status: 404, detail: "Function '09c64e32-2b65-4892-a285-2f585408d118': Not found for account 'abcDEF123'" }) });
    assert.equal(missing.status, "failed");
    assert.equal(missing.retired, false);
    assert.match(missing.steps.plain!.detail!, /^Not callable on this key: The model function: Not found for this account$/);
    const busy = await probeEmbedding(embedTarget, { fetchImpl: embedFetch({ status: 503 }) });
    assert.equal(busy.status, "inconclusive");
});

await check("embedding: Gemini sends task types and uses batchEmbedContents for two texts", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const one = (entry: Record<string, unknown>) => ({ values: fakeVector(((entry.content as { parts: { text: string }[] }).parts[0].text), entry.taskType === "RETRIEVAL_QUERY" ? "query" : "passage", 7, typeof entry.outputDimensionality === "number" ? entry.outputDimensionality : 1024) });
        return Array.isArray(body.requests) ? json(200, { embeddings: (body.requests as Record<string, unknown>[]).map(one) }) : json(200, { embedding: one(body) });
    }) as typeof fetch;
    const result = await probeEmbedding({ provider: gemini, modelId: "gemini-embedding-2", apiKey: "fixture-key" }, { fetchImpl });
    assert.equal(result.status, "passed");
    assert.equal(result.steps.plain, undefined, "Gemini has no untyped step");
    assert.equal(result.traits.batch, true);
    assert.ok(urls.some((url) => url.endsWith(":batchEmbedContents")));
});

function pcmTone(seconds: number, rate: number, amplitude = 8000): Buffer {
    const out = Buffer.alloc(Math.round(seconds * rate) * 2);
    for (let index = 0; index < out.length / 2; index++) out.writeInt16LE(Math.round(amplitude * Math.sin(index / 8)), index * 2);
    return out;
}
function streamOf(bytes: Buffer, sizes: number[]): ReadableStream<Uint8Array> {
    let offset = 0, part = 0;
    return new ReadableStream({
        pull(controller) {
            if (offset >= bytes.length) return controller.close();
            const size = sizes[part++ % sizes.length];
            controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)));
            offset += size;
        },
    });
}

await check("speech: streamed PCM keeps its rate and odd chunk boundaries", async () => {
    const audio = pcmTone(3, 44100);
    const fetchImpl = (async () => new Response(streamOf(audio, [1001, 2048, 777]), { status: 200, headers: { "content-type": "audio/pcm;rate=44100;channels=1" } })) as unknown as typeof fetch;
    const result = await probeSpeech({ provider: openrouter, modelId: "vendor/voice:free", apiKey: "fixture-key", listedVoices: ["nadine", "bram"] }, { fetchImpl });
    assert.equal(result.status, "passed");
    assert.deepEqual({ ...result.traits, firstAudioMs: 0 }, { voices: ["nadine", "bram"], defaultVoice: "nadine", audioFormat: "pcm", sampleRate: 44100, channels: 1, audioSec: 3, firstAudioMs: 0 });
});

await check("speech: a refused PCM request is retried as WAV; MP3-only and silent audio fail", async () => {
    const formats: string[] = [];
    const wavFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const format = (JSON.parse(String(init?.body)) as { response_format: string }).response_format;
        formats.push(format);
        if (format !== "wav") return json(400, { error: { message: "response_format must be wav" } });
        return new Response(new Uint8Array(pcmToWav(pcmTone(2.5, 24000), 24000)), { status: 200, headers: { "content-type": "audio/wav" } });
    }) as typeof fetch;
    const wav = await probeSpeech({ provider: groq, modelId: "canopylabs/orpheus-v1-english", apiKey: "fixture-key" }, { fetchImpl: wavFetch });
    assert.equal(wav.status, "passed");
    assert.deepEqual(formats, ["pcm", "wav"]);
    assert.equal(wav.traits.audioFormat, "wav");
    assert.equal(wav.traits.defaultVoice, "autumn", "Groq Orpheus voices are pinned");
    const mp3 = await probeSpeech({ provider: openrouter, modelId: "vendor/mp3", apiKey: "fixture-key" }, {
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
            const format = (JSON.parse(String(init?.body)) as { response_format: string }).response_format;
            return json(400, { error: { message: `Invalid option: expected "mp3" for response_format, got "${format}"` } });
        }) as typeof fetch,
    });
    assert.equal(mp3.status, "failed");
    assert.match(mp3.steps.speak.detail!, /Audio format not supported/);
    const silent = await probeSpeech({ provider: openrouter, modelId: "vendor/quiet", apiKey: "fixture-key" }, {
        fetchImpl: (async () => new Response(new Uint8Array(Buffer.alloc(24000 * 2 * 3)), { status: 200, headers: { "content-type": "audio/pcm;rate=24000" } })) as unknown as typeof fetch,
    });
    assert.equal(silent.status, "failed");
    assert.match(silent.steps.speak.detail!, /silent/);
});

await check("speech: Gemini SSE gives L16 chunks or a WAV part, and a 410 is retired", async () => {
    const sse = (parts: { mimeType: string; data: Buffer }[]) => parts.map((part) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: part.mimeType, data: part.data.toString("base64") } }] } }] })}\n\n`).join("");
    const tone = pcmTone(3, 24000);
    const l16 = await probeSpeech({ provider: gemini, modelId: "gemini-3.8-flash-tts", apiKey: "fixture-key" }, {
        fetchImpl: (async () => new Response(sse([{ mimeType: "audio/L16;codec=pcm;rate=24000", data: tone.subarray(0, 48000) }, { mimeType: "audio/L16;codec=pcm;rate=24000", data: tone.subarray(48000) }]), { status: 200 })) as unknown as typeof fetch,
    });
    assert.equal(l16.status, "passed");
    assert.equal(l16.traits.defaultVoice, "Kore");
    assert.equal(l16.traits.voices?.length, 30);
    const wav = await probeSpeech({ provider: gemini, modelId: "gemini-3.8-flash-tts", apiKey: "fixture-key" }, {
        fetchImpl: (async () => new Response(sse([{ mimeType: "audio/wav", data: pcmToWav(tone, 24000) }]), { status: 200 })) as unknown as typeof fetch,
    });
    assert.equal(wav.status, "passed");
    assert.equal(wav.traits.audioSec, 3);
    const gone = await probeSpeech({ provider: gemini, modelId: "gemini-old-tts", apiKey: "fixture-key" }, {
        fetchImpl: (async () => json(410, { error: { message: "The model has reached its end of life on 2026-12-01." } })) as unknown as typeof fetch,
    });
    assert.equal(gone.retired, true);
    assert.equal(gone.retiredAt, "2026-12-01T00:00:00.000Z");
});

await check("transcription: request shapes per provider and the accuracy threshold", async () => {
    const seen: { url: string; contentType: string | null; body: unknown }[] = [];
    const reply = (text: string) => (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), contentType: headers.get("content-type"), body: init?.body });
        return String(url).includes("generativelanguage")
            ? json(200, { candidates: [{ content: { parts: [{ text }] } }] })
            : json(200, { text });
    }) as typeof fetch;
    const groqResult = await probeTranscription({ provider: groq, modelId: "whisper-large-v3-turbo", apiKey: "fixture-key" }, { fetchImpl: reply(" The quick brown fox jumps over the lazy dog. ") });
    assert.equal(groqResult.status, "passed");
    assert.equal(groqResult.traits.accuracy, 1);
    assert.ok(seen[0].body instanceof FormData, "Groq gets multipart form data");
    assert.equal(seen[0].url, "https://groq.invalid/openai/v1/audio/transcriptions");
    const orResult = await probeTranscription({ provider: openrouter, modelId: "openai/whisper-large-v3-turbo", apiKey: "fixture-key" }, { fetchImpl: reply("the quick brown box jumps over the lazy dog") });
    assert.equal(orResult.status, "passed", "8 of 9 words clears the 80% bar");
    assert.equal(orResult.traits.accuracy, 0.89);
    const nearMiss = await probeTranscription({ provider: openrouter, modelId: "openai/whisper-large-v3-turbo", apiKey: "fixture-key" }, { fetchImpl: reply("the quick brown box jumps over a lazy dog") });
    assert.equal(nearMiss.status, "failed", "7 of 9 words is under the bar");
    seen.splice(2, 1);
    const orBody = JSON.parse(String(seen[1].body)) as { input_audio: { format: string; data: string } };
    assert.equal(orBody.input_audio.format, "wav");
    assert.equal(Buffer.from(orBody.input_audio.data, "base64").length, probeClip().length);
    const geminiResult = await probeTranscription({ provider: gemini, modelId: "gemini-3.5-flash-lite", apiKey: "fixture-key" }, { fetchImpl: reply("a fox") });
    assert.equal(geminiResult.status, "failed");
    const geminiBody = JSON.parse(String(seen[2].body)) as { contents: { parts: Record<string, unknown>[] }[] };
    assert.equal(geminiBody.contents[0].parts.length, 2, "a chat model gets an instruction");
    await probeTranscription({ provider: gemini, modelId: "gemini-3.5-transcribe", apiKey: "fixture-key" }, { fetchImpl: reply("The quick brown fox jumps over the lazy dog.") });
    assert.equal((JSON.parse(String(seen[3].body)) as { contents: { parts: unknown[] }[] }).contents[0].parts.length, 1, "a transcribe model gets the audio alone");
});

await check("helpers: word accuracy, WAV chunks, retirement dates and scrubbed details", () => {
    assert.equal(wordAccuracy("the quick brown fox", "The quick, brown fox!"), 1);
    assert.equal(wordAccuracy("the quick brown fox", "quick fox"), 0.5);
    assert.equal(wordAccuracy("the quick brown fox", ""), 0);
    const plain = pcmToWav(pcmTone(1, 16000), 16000);
    const list = Buffer.from("LIST\x04\x00\x00\x00abcd", "binary");
    const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4);
    const parsed = parseWav(withList)!;
    assert.equal(parsed.sampleRate, 16000);
    assert.equal(parsed.pcm.length, 32000);
    assert.equal(parseWav(Buffer.from("not a wav")), null);
    assert.equal(parseWav(probeClip())!.sampleRate, 16000);
    assert.equal(retiredAtFrom("reached its end of life on 2026-11-23T09:00:00Z"), "2026-11-23T09:00:00.000Z");
    assert.equal(retiredAtFrom("Gone"), null);
    assert.equal(errorDetail(JSON.stringify({ detail: "Function 'b51e8011-e772-4c9a-8b02-618e99ae4467': Not found for account 'Xyz'" }), 404), "The model function: Not found for this account");
});

console.log(`${checks} typed probe checks passed`);
