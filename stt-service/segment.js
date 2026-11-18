"use strict";

// Moonshine tiny's memory grows quickly with length (one 41 s decode peaked at 422 MB). Over 140 turns the
// service held about 220 MB with 15 s pieces and 267 to 295 MB with 20 s pieces. Every cut cost some accuracy
// in testing, so only turns longer than the limit are cut, at the quietest point.
const DEFAULTS = { sampleRate: 16000, maxSec: 15, minSec: 7.5, windowSec: 0.4, stepSec: 0.05 };

function pcm16ToFloat32(buffer) {
    const samples = new Float32Array(buffer.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2) / 32768;
    return samples;
}

function quietestCut(samples, from, to, windowLen, step) {
    let best = from, bestEnergy = Infinity;
    for (let start = from; start + windowLen <= to; start += step) {
        let energy = 0;
        for (let i = start; i < start + windowLen; i++) energy += samples[i] * samples[i];
        if (energy < bestEnergy) { bestEnergy = energy; best = start; }
    }
    return best + (windowLen >> 1);
}

// Returns [start, end) sample ranges, each no longer than maxSec.
function segment(samples, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const maxLen = Math.round(o.maxSec * o.sampleRate);
    const minLen = Math.round(o.minSec * o.sampleRate);
    const windowLen = Math.round(o.windowSec * o.sampleRate);
    const step = Math.max(1, Math.round(o.stepSec * o.sampleRate));
    const ranges = [];
    let start = 0;
    while (samples.length - start > maxLen) {
        const cut = quietestCut(samples, start + minLen, start + maxLen, windowLen, step);
        ranges.push([start, cut]);
        start = cut;
    }
    if (samples.length > start) ranges.push([start, samples.length]);
    return ranges;
}

module.exports = { segment, pcm16ToFloat32 };
