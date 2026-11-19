import assert from "node:assert/strict";
import { speakableEnd } from "../src/app/home/speech-chunks";

const ready = (text: string, from = 0) => text.slice(from, speakableEnd(text, from));

// Sentences and lines are ready once the next character shows they ended.
assert.equal(ready("Hello there. How are"), "Hello there.");
assert.equal(ready("Hello there."), "");
assert.equal(ready("Great news! It is sunny? Yes"), "Great news! It is sunny?");
assert.equal(ready("Steps:\n- one"), "Steps:\n");
assert.equal(ready('He said "hi." Then'), 'He said "hi."');
assert.equal(ready("It is **done.** More"), "It is **done.**");
assert.equal(ready("Hello there. How are you? Fine", 12), " How are you?");
// Numbers, initials and abbreviations do not end a sentence; decimals and times never had a space.
assert.equal(ready("1. First item"), "");
assert.equal(ready("See e.g. the docs. Then"), "See e.g. the docs.");
assert.equal(ready("Ask Dr. Lee. Then"), "Ask Dr. Lee.");
assert.equal(ready("It costs $12.99 at 3.30 pm. Next"), "It costs $12.99 at 3.30 pm.");
// Code fences are spoken whole, never split inside.
assert.equal(ready("Run this:\n```js\nconst a = 1. b\n```\nDone. Next"), "Run this:\n```js\nconst a = 1. b\n```\nDone.");
assert.equal(ready("Here:\n```\ncode. more\n"), "Here:\n");
assert.equal(ready("```\nx. y\n```\nAfter. Then", 0), "```\nx. y\n```\nAfter.");

// The speaker, against a fake /api/tts and a fake Web Audio clock.
const starts: number[] = [];
const contexts: string[] = [];
const clock = () => performance.now() / 1000;
class FakeAudioContext {
    state = "running";
    get currentTime() { return clock(); }
    constructor() { contexts.push("open"); }
    async resume() { }
    async close() { contexts.push("closed"); }
    createBuffer(_channels: number, length: number, rate: number) {
        return { duration: length / rate, getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
        return { buffer: null, connect() { }, start(at: number) { starts.push(at); } };
    }
    createAnalyser() {
        return { fftSize: 2048, connect() { }, getFloatTimeDomainData() { } };
    }
    get destination() { return {}; }
}
Object.assign(globalThis, { AudioContext: FakeAudioContext });
const { ReplySpeaker, SPOKEN_REPLY_MAX_CHARS } = await import("../src/app/home/reply-speaker");

type Call = { text: string; freeOnly: boolean };
function fakeTts(status: (call: Call, index: number) => number = () => 200) {
    const calls: Call[] = [];
    let inFlight = 0, maxInFlight = 0;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const call = JSON.parse(String(init?.body)) as Call & { stream: boolean };
        assert.equal(call.stream, true);
        calls.push(call);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight--;
        init?.signal?.throwIfAborted();
        const code = status(call, calls.length - 1);
        if (code !== 200) return Response.json({ error: "x" }, { status: code });
        return new Response(new Uint8Array(2400), { headers: { "X-Sample-Rate": "24000" } });
    }) as typeof fetch;
    return { calls, fetchImpl, maxInFlight: () => maxInFlight };
}
const ended = () => {
    let settle: (value: { end: string; error?: unknown }) => void = () => { };
    const promise = new Promise<{ end: string; error?: unknown }>((resolve) => { settle = resolve; });
    return { promise, onEnd: (end: string, error?: unknown) => settle({ end, error }) };
};

// One request at a time: text queued during a request goes out as one batch, then the reply ends.
{
    const tts = fakeTts();
    const end = ended();
    let waited = false;
    const speaker = new ReplySpeaker({ freeOnly: true, fetchImpl: tts.fetchImpl, onEnd: end.onEnd,
        beforeFirstAudio: async () => { assert.equal(contexts.length, 0, "audio starts only after the filler wait"); waited = true; } });
    assert.equal(speaker.push("First sentence."), true);
    speaker.push(" Second one.");
    speaker.push(" Third one.");
    speaker.finish();
    assert.deepEqual(await end.promise, { end: "done", error: undefined });
    assert.ok(waited);
    assert.deepEqual(tts.calls.map((call) => call.text), ["First sentence.", " Second one. Third one."]);
    assert.equal(tts.calls[0].freeOnly, true);
    assert.equal(tts.maxInFlight(), 1);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] >= starts[0] + 0.05 - 1e-9, "the second chunk is scheduled after the first");
    assert.deepEqual(contexts, ["open", "closed"]);
}

// Chunks with nothing to say are not sent; the length limit stops further text.
{
    const tts = fakeTts();
    const end = ended();
    const speaker = new ReplySpeaker({ freeOnly: false, fetchImpl: tts.fetchImpl, onEnd: end.onEnd });
    speaker.push("---\n");
    speaker.push("Words here. ");
    assert.equal(speaker.push("x".repeat(SPOKEN_REPLY_MAX_CHARS)), false);
    speaker.finish();
    assert.equal((await end.promise).end, "done");
    assert.deepEqual(tts.calls.map((call) => call.text), ["Words here. "]);
}

// A failed first chunk is an error; a later failed chunk is skipped.
{
    const first = ended();
    const failing = new ReplySpeaker({ freeOnly: false, fetchImpl: fakeTts(() => 502).fetchImpl, onEnd: first.onEnd });
    failing.push("Nothing works.");
    failing.finish();
    const result = await first.promise;
    assert.equal(result.end, "error");
    assert.match(String(result.error), /502/);

    const later = ended();
    const tts = fakeTts((_call, index) => (index === 1 ? 502 : 200));
    const skipping = new ReplySpeaker({ freeOnly: false, fetchImpl: tts.fetchImpl, onEnd: later.onEnd });
    skipping.push("One.");
    await new Promise((resolve) => setTimeout(resolve, 60));
    skipping.push(" Two.");
    await new Promise((resolve) => setTimeout(resolve, 60));
    skipping.push(" Three.");
    skipping.finish();
    assert.equal((await later.promise).end, "done");
    assert.deepEqual(tts.calls.map((call) => call.text), ["One.", " Two.", " Three."]);
}

// Stopping aborts the request in flight and reports nothing.
{
    let ends = 0;
    let aborted = false;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        aborted = !!init?.signal?.aborted;
        init?.signal?.throwIfAborted();
        return new Response(new Uint8Array(2400), { headers: { "X-Sample-Rate": "24000" } });
    }) as typeof fetch;
    const speaker = new ReplySpeaker({ freeOnly: false, fetchImpl, onEnd: () => { ends++; } });
    speaker.push("Long reply.");
    speaker.finish();
    speaker.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(aborted);
    assert.equal(ends, 0);
    assert.equal(speaker.push("More."), false);
}

console.log("Reply speech: sentence chunks, one request at a time, batching, skips, limits and stop passed offline.");
