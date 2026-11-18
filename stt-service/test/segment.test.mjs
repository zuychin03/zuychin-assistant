import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const { segment, pcm16ToFloat32 } = createRequire(import.meta.url)("../segment.js");
const RATE = 16000;

function noise(seconds, silentSpans = []) {
    const samples = new Float32Array(Math.round(seconds * RATE));
    let seed = 7;
    for (let i = 0; i < samples.length; i++) {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        samples[i] = (seed / 4294967296 - 0.5) * 0.6;
    }
    for (const [from, to] of silentSpans) samples.fill(0, Math.round(from * RATE), Math.round(to * RATE));
    return samples;
}

function assertCovers(ranges, length, maxSec = 15) {
    assert.equal(ranges[0][0], 0);
    assert.equal(ranges.at(-1)[1], length);
    for (let i = 0; i < ranges.length; i++) {
        assert.ok(ranges[i][1] - ranges[i][0] <= maxSec * RATE, `range ${i} is longer than ${maxSec} s`);
        if (i) assert.equal(ranges[i][0], ranges[i - 1][1], "ranges must be contiguous");
    }
}

test("short and exactly-15 s audio stay in one piece", () => {
    assert.deepEqual(segment(noise(4)), [[0, 4 * RATE]]);
    assert.deepEqual(segment(noise(15)), [[0, 15 * RATE]]);
});

test("long audio is cut inside its quiet gaps", () => {
    const samples = noise(40, [[12, 12.5], [26, 26.5]]);
    const ranges = segment(samples);
    assertCovers(ranges, samples.length);
    assert.equal(ranges.length, 3);
    const cuts = ranges.slice(1).map(([start]) => start / RATE);
    assert.ok(cuts[0] >= 12 && cuts[0] <= 12.5, `first cut at ${cuts[0]} s`);
    assert.ok(cuts[1] >= 26 && cuts[1] <= 26.5, `second cut at ${cuts[1]} s`);
});

test("audio with no pauses is still cut at or under the limit", () => {
    const samples = noise(60);
    const ranges = segment(samples);
    assertCovers(ranges, samples.length);
    for (const [start, end] of ranges.slice(0, -1)) assert.ok(end - start >= 7.5 * RATE, "cuts never come before the minimum");
});

test("16-bit PCM converts to the -1..1 range", () => {
    const buffer = Buffer.alloc(6);
    buffer.writeInt16LE(-32768, 0);
    buffer.writeInt16LE(0, 2);
    buffer.writeInt16LE(16384, 4);
    assert.deepEqual([...pcm16ToFloat32(buffer)], [-1, 0, 0.5]);
});
