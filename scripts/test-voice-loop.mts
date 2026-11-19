import assert from "node:assert/strict";
import { STOP_PHRASE, VOICE_FILLERS, hasStopPhrase, pickFiller, startsWork, warmupDetail } from "../src/app/home/voice-loop";

for (const said of [
    STOP_PHRASE,
    "that's enough thank you",
    "That's enough. Thank you.",
    "thats enough, thank you",
    "That is enough, thank you",
    "That’s enough, thanks",
    "okay that's enough thank you",
]) assert.equal(hasStopPhrase(said), true, said);

for (const said of [
    "Zuychin, stop",
    "is that enough sugar for the cake",
    "that's enough for today, can you add milk to the list",
    "thank you, that's great",
    "",
]) assert.equal(hasStopPhrase(said), false, said);

assert.equal(VOICE_FILLERS[0], "Just a minute.");
assert.equal(new Set(VOICE_FILLERS).size, VOICE_FILLERS.length);
assert.equal(pickFiller(undefined, () => 0), VOICE_FILLERS[0]);
assert.equal(pickFiller(undefined, () => 0.999999), VOICE_FILLERS[VOICE_FILLERS.length - 1]);
for (let i = 0; i < 200; i++) {
    const previous = VOICE_FILLERS[i % VOICE_FILLERS.length];
    const next = pickFiller(previous);
    assert.notEqual(next, previous);
    assert.ok((VOICE_FILLERS as readonly string[]).includes(next));
}
const seen = new Set(Array.from({ length: VOICE_FILLERS.length - 1 }, (_, i) => pickFiller(VOICE_FILLERS[0], () => i / (VOICE_FILLERS.length - 1))));
assert.equal(seen.size, VOICE_FILLERS.length - 1);

assert.equal(startsWork({ type: "run", runId: "r" }), true);
assert.equal(startsWork({ type: "status", message: "Planning…" }), true);
assert.equal(startsWork({ type: "plan", steps: [] }), true);
assert.equal(startsWork({ type: "tool", name: "search_web", phase: "start" }), true);
assert.equal(startsWork({ type: "tool", name: "search_web", phase: "start", chat: true }), true);
assert.equal(startsWork({ type: "tool", name: "search_web", phase: "done" }), false);
assert.equal(startsWork({ type: "subagent", objective: "o", model: "m", phase: "start" }), true);
assert.equal(startsWork({ type: "subagent", objective: "o", model: "m", phase: "done" }), false);
assert.equal(startsWork({ type: "token", text: "Hi" }), false);
assert.equal(startsWork({ type: "error", message: "x" }), false);

assert.equal(warmupDetail(true, true), "Loading speech recognition and the voice");
assert.equal(warmupDetail(true, false), "Loading speech recognition");
assert.equal(warmupDetail(false, true), "Loading the voice");
assert.equal(warmupDetail(false, false), "Waking the voice models");

console.log("voice loop: stop phrase, fillers, work events and warm-up text ok");
