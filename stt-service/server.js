"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { segment, pcm16ToFloat32 } = require("./segment.js");

const SAMPLE_RATE = 16000;
const MAX_BYTES = 60 * SAMPLE_RATE * 2;

const digest = (value) => crypto.createHash("sha256").update(value).digest();

function tokenMatches(header, token) {
    const match = /^Bearer (\S+)$/.exec(header || "");
    return Boolean(match) && crypto.timingSafeEqual(digest(match[1]), digest(token));
}

// Over-limit bodies are drained rather than cut off, so the client still reads the 413.
function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size <= limit) chunks.push(chunk);
        });
        req.on("end", () => (size > limit ? reject(Object.assign(new Error("too_large"), { status: 413 })) : resolve(Buffer.concat(chunks))));
        req.on("error", reject);
    });
}

function send(res, status, body) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}

// Logs carry sizes and timings only, never transcript text.
function createServer({ token, recognizer = null, maxBytes = MAX_BYTES, maxWaiting = 2, timeoutMs = 14000, segmentOptions, log = (entry) => console.log(JSON.stringify(entry)) }) {
    if (!token) throw new Error("A token is required.");
    const state = { recognizer, active: 0, queue: [] };
    const waiting = () => state.queue.filter((job) => !job.done).length;

    async function run(job) {
        try {
            const texts = [];
            for (const [start, end] of job.ranges) {
                if (job.done) break;
                texts.push(await state.recognizer.transcribe(job.samples.subarray(start, end)));
            }
            job.finish(null, texts.filter(Boolean).join(" "));
        } catch (error) {
            job.finish(error);
        }
    }

    function pump() {
        if (state.active || !state.queue.length) return;
        const job = state.queue.shift();
        if (job.done) return pump();
        state.active = 1;
        job.startedAt = Date.now();
        run(job).finally(() => {
            state.active = 0;
            // Streams hold native memory V8 cannot see; without this, 140 turns peaked at 372 MB instead of 301 MB.
            if (global.gc) global.gc();
            pump();
        });
    }

    async function transcribe(req, res) {
        if (!tokenMatches(req.headers.authorization, token)) return reject(res, 401, "unauthorised", req);
        if (!String(req.headers["content-type"] || "").startsWith("application/octet-stream")) return reject(res, 415, "content_type", req);
        if (req.headers["x-sample-rate"] !== String(SAMPLE_RATE)) return reject(res, 415, "sample_rate", req);
        let body;
        try {
            body = await readBody(req, maxBytes);
        } catch (error) {
            return reject(res, error.status || 400, error.status === 413 ? "too_large" : "read_failed");
        }
        if (!body.length || body.length % 2) return reject(res, 400, "bad_pcm");
        if (!state.recognizer) return reject(res, 503, "loading");
        if (state.active + waiting() >= 1 + maxWaiting) return reject(res, 503, "busy");

        const samples = pcm16ToFloat32(body);
        const audioSec = +(samples.length / SAMPLE_RATE).toFixed(2);
        const job = { samples, ranges: segment(samples, segmentOptions), done: false, arrivedAt: Date.now(), startedAt: 0 };
        const entry = () => ({ event: "transcribe", bytes: body.length, audioSec, segments: job.ranges.length,
            waitMs: (job.startedAt || Date.now()) - job.arrivedAt, decodeMs: job.startedAt ? Date.now() - job.startedAt : 0 });
        const timer = setTimeout(() => {
            if (job.done) return;
            job.done = true;
            log({ ...entry(), status: 503, error: job.startedAt ? "timeout" : "queue_timeout" });
            send(res, 503, { error: "timeout" });
        }, timeoutMs);
        res.on("close", () => {
            if (job.done) return;
            job.done = true;
            clearTimeout(timer);
            log({ ...entry(), status: 499, error: "client_closed" });
        });
        job.finish = (error, text) => {
            clearTimeout(timer);
            if (job.done) {
                log({ ...entry(), event: "late", error: error ? "decode_failed" : undefined });
                return;
            }
            job.done = true;
            const info = entry();
            if (error) {
                log({ ...info, status: 500, error: "decode_failed" });
                return send(res, 500, { error: "decode_failed" });
            }
            log({ ...info, status: 200, chars: text.length });
            send(res, 200, { text, audioSec, decodeMs: info.decodeMs, model: state.recognizer.model });
        };
        state.queue.push(job);
        pump();
    }

    // An unread body would reset the connection under the client, so drain it before replying.
    function reject(res, status, error, unreadRequest) {
        if (unreadRequest) unreadRequest.resume();
        log({ event: "rejected", status, error });
        send(res, status, { error });
    }

    const server = http.createServer((req, res) => {
        if (req.method !== "POST") req.resume();
        const { pathname } = new URL(req.url, "http://127.0.0.1");
        if (pathname === "/health") {
            if (req.method !== "GET") return req.resume(), send(res, 405, { error: "method" });
            return send(res, 200, { ok: true, model: state.recognizer ? state.recognizer.model : null, loaded: Boolean(state.recognizer),
                busy: state.active > 0, waiting: waiting() });
        }
        if (pathname === "/transcribe") {
            if (req.method !== "POST") return send(res, 405, { error: "method" });
            return void transcribe(req, res).catch(() => send(res, 500, { error: "internal" }));
        }
        req.resume();
        send(res, 404, { error: "not_found" });
    });
    server.setRecognizer = (value) => { state.recognizer = value; };
    return server;
}

async function main() {
    const token = process.env.STT_TOKEN || "";
    const modelDir = process.env.STT_MODEL_DIR || "";
    const port = Number(process.env.STT_PORT || 3010);
    const segmentSec = Number(process.env.STT_SEGMENT_SEC || 15);
    if (token.length < 32) throw new Error("STT_TOKEN must be set to at least 32 characters.");
    if (!(segmentSec >= 5 && segmentSec <= 60)) throw new Error("STT_SEGMENT_SEC must be between 5 and 60.");
    for (const file of ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"]) {
        if (!modelDir || !fs.existsSync(path.join(modelDir, file))) throw new Error(`STT_MODEL_DIR must hold ${file}.`);
    }
    const server = createServer({ token, segmentOptions: { maxSec: segmentSec, minSec: segmentSec / 2 } });
    // Loopback only: the app is the sole client, and the service is never added to the tunnel.
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    console.log(JSON.stringify({ event: "listening", port }));
    const startedAt = Date.now();
    const { loadRecognizer } = require("./recognizer.js");
    server.setRecognizer(await loadRecognizer(modelDir));
    console.log(JSON.stringify({ event: "loaded", ms: Date.now() - startedAt, rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
    const stop = () => server.close(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(JSON.stringify({ event: "fatal", error: error.message }));
        process.exit(1);
    });
}

module.exports = { createServer, MAX_BYTES, SAMPLE_RATE };
