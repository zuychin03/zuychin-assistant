import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { createRequire } from "node:module";

const { createServer, activationFd } = createRequire(import.meta.url)("../server.js");
const TOKEN = "t".repeat(64);
const RATE = 16000;

function pcm(seconds, silentSpans = []) {
    const buffer = Buffer.alloc(Math.round(seconds * RATE) * 2);
    for (let i = 0; i < buffer.length / 2; i++) {
        const t = i / RATE;
        const silent = silentSpans.some(([from, to]) => t >= from && t < to);
        buffer.writeInt16LE(silent ? 0 : Math.round(Math.sin(i / 7) * 8000), i * 2);
    }
    return buffer;
}

function fakeRecognizer({ hold = false, fail = null, text = (n) => `words ${n}` } = {}) {
    const pending = [];
    const fake = {
        model: "fake-model",
        calls: [],
        hold,
        transcribe(samples) {
            fake.calls.push(samples.length);
            if (fail) return Promise.reject(new Error(fail));
            if (!fake.hold) return Promise.resolve(text(fake.calls.length));
            const n = fake.calls.length;
            return new Promise((resolve) => pending.push(() => resolve(text(n))));
        },
        release() { while (pending.length) pending.shift()(); },
    };
    return fake;
}

async function start(options = {}) {
    const logs = [];
    const server = createServer({ token: TOKEN, log: (entry) => logs.push(entry), ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, base, logs, close: () => new Promise((resolve) => server.close(resolve)) };
}

function post(base, body, headers = {}) {
    return fetch(`${base}/transcribe`, {
        method: "POST",
        body,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream", "X-Sample-Rate": "16000", ...headers },
    });
}

// Node's fetch re-sends a body after any 401 and fails on a used Buffer, so 401 cases use node:http.
function rawPost(base, body, headers) {
    return new Promise((resolve, reject) => {
        const req = request(`${base}/transcribe`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Sample-Rate": "16000", ...headers } }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end(body);
    });
}

const health = async (base) => (await fetch(`${base}/health`)).json();

async function until(check, ms = 2000) {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("health needs no token and shows the load state without secrets", async () => {
    const s = await start();
    try {
        const response = await fetch(`${s.base}/health`);
        const text = await response.text();
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(text), { ok: true, model: null, loaded: false, busy: false, waiting: 0 });
        assert.ok(!text.includes(TOKEN));
        s.server.setRecognizer(fakeRecognizer());
        assert.equal((await health(s.base)).loaded, true);
        assert.equal((await health(s.base)).model, "fake-model");
    } finally { await s.close(); }
});

test("a missing or wrong token is refused before any decode", async () => {
    const fake = fakeRecognizer();
    const s = await start({ recognizer: fake });
    try {
        assert.equal(await rawPost(s.base, pcm(1), {}), 401);
        assert.equal(await rawPost(s.base, pcm(1), { Authorization: `Bearer ${"x".repeat(64)}` }), 401);
        assert.equal(await rawPost(s.base, pcm(1), { Authorization: TOKEN }), 401);
        assert.equal(await rawPost(s.base, pcm(1), { Authorization: `Bearer ${TOKEN}` }), 200);
        assert.equal(fake.calls.length, 1);
    } finally { await s.close(); }
});

test("content type and sample rate are checked", async () => {
    const s = await start({ recognizer: fakeRecognizer() });
    try {
        assert.equal((await post(s.base, pcm(1), { "Content-Type": "audio/wav" })).status, 415);
        assert.equal((await post(s.base, pcm(1), { "X-Sample-Rate": "44100" })).status, 415);
        const missing = await fetch(`${s.base}/transcribe`, { method: "POST", body: pcm(1),
            headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream" } });
        assert.equal(missing.status, 415);
    } finally { await s.close(); }
});

test("bodies over the limit get 413, with or without a length header", async () => {
    const fake = fakeRecognizer();
    const s = await start({ recognizer: fake, maxBytes: 1000 });
    try {
        const sized = await post(s.base, Buffer.alloc(2000));
        assert.equal(sized.status, 413);
        assert.deepEqual(await sized.json(), { error: "too_large" });
        const chunks = [Buffer.alloc(600), Buffer.alloc(600)];
        const stream = new ReadableStream({
            pull(controller) {
                if (chunks.length) controller.enqueue(chunks.shift());
                else controller.close();
            },
        });
        const chunked = await fetch(`${s.base}/transcribe`, { method: "POST", body: stream, duplex: "half",
            headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream", "X-Sample-Rate": "16000" } });
        assert.equal(chunked.status, 413);
        assert.equal((await post(s.base, Buffer.alloc(1000))).status, 200);
        assert.equal(fake.calls.length, 1);
    } finally { await s.close(); }
});

test("empty or odd-length PCM is rejected", async () => {
    const s = await start({ recognizer: fakeRecognizer() });
    try {
        assert.equal((await post(s.base, Buffer.alloc(0))).status, 400);
        assert.equal((await post(s.base, Buffer.alloc(3))).status, 400);
    } finally { await s.close(); }
});

test("a request that arrives while the model loads waits for it, then decodes", async () => {
    const fake = fakeRecognizer();
    const s = await start();
    try {
        const pending = post(s.base, pcm(1));
        await until(async () => (await health(s.base)).waiting === 1);
        assert.equal(fake.calls.length, 0);
        s.server.setRecognizer(fake);
        const response = await pending;
        assert.equal(response.status, 200);
        assert.equal((await response.json()).text, "words 1");
    } finally { await s.close(); }
});

test("a request still waiting for the model at its deadline gets 503 and is never decoded", async () => {
    const fake = fakeRecognizer();
    const s = await start({ timeoutMs: 100 });
    try {
        const response = await post(s.base, pcm(1));
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: "timeout" });
        assert.equal(s.logs.find((l) => l.status === 503).error, "queue_timeout");
        s.server.setRecognizer(fake);
        await until(async () => !(await health(s.base)).busy);
        assert.equal(fake.calls.length, 0);
    } finally { await s.close(); }
});

test("every response closes its connection, so no socket outlives an idle exit", async () => {
    const s = await start({ recognizer: fakeRecognizer() });
    try {
        assert.equal((await fetch(`${s.base}/health`)).headers.get("connection"), "close");
        assert.equal((await post(s.base, pcm(1))).headers.get("connection"), "close");
        assert.equal((await post(s.base, Buffer.alloc(3))).headers.get("connection"), "close");
    } finally { await s.close(); }
});

test("the idle exit fires once nothing has happened for the idle time, and never mid-decode", async () => {
    const fake = fakeRecognizer({ hold: true });
    let idled = 0;
    const s = await start({ recognizer: fake, idleMs: 400, onIdle: () => { idled += 1; } });
    try {
        const running = post(s.base, pcm(1));
        await until(async () => fake.calls.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.equal(idled, 0, "a decode longer than the idle time does not count as idle");
        fake.hold = false;
        fake.release();
        assert.equal((await running).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await health(s.base);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(idled, 0, "a health check restarts the countdown");
        await until(async () => idled === 1, 2000);
        assert.ok(s.logs.some((l) => l.event === "idle_exit"));
    } finally { await s.close(); }
});

test("without an idle time the service never exits on its own", async () => {
    let idled = 0;
    const s = await start({ recognizer: fakeRecognizer(), onIdle: () => { idled += 1; } });
    try {
        await post(s.base, pcm(1));
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(idled, 0);
    } finally { await s.close(); }
});

test("socket activation is used only when systemd passed a socket to this process", () => {
    assert.equal(activationFd({ LISTEN_PID: "42", LISTEN_FDS: "1" }, 42), 3);
    assert.equal(activationFd({ LISTEN_PID: "41", LISTEN_FDS: "1" }, 42), null);
    assert.equal(activationFd({ LISTEN_PID: "42", LISTEN_FDS: "0" }, 42), null);
    assert.equal(activationFd({}, 42), null);
});

test("a transcript comes back, and the log holds timings but no text", async () => {
    const s = await start({ recognizer: fakeRecognizer({ text: () => "remind me about the dentist" }) });
    try {
        const response = await post(s.base, pcm(2.5));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.text, "remind me about the dentist");
        assert.equal(body.audioSec, 2.5);
        assert.equal(body.model, "fake-model");
        assert.equal(typeof body.decodeMs, "number");
        const entry = s.logs.find((log) => log.event === "transcribe");
        assert.equal(entry.status, 200);
        assert.equal(entry.audioSec, 2.5);
        assert.equal(entry.segments, 1);
        assert.ok(!JSON.stringify(s.logs).includes("dentist"));
    } finally { await s.close(); }
});

test("one decode runs at a time with two waiting, and a fourth request is busy", async () => {
    const fake = fakeRecognizer({ hold: true });
    const s = await start({ recognizer: fake });
    try {
        const first = [post(s.base, pcm(1)), post(s.base, pcm(1)), post(s.base, pcm(1))];
        await until(async () => { const h = await health(s.base); return h.busy && h.waiting === 2; });
        assert.equal(fake.calls.length, 1);
        const busy = await post(s.base, pcm(1));
        assert.equal(busy.status, 503);
        assert.deepEqual(await busy.json(), { error: "busy" });
        fake.hold = false;
        fake.release();
        const results = await Promise.all(first);
        assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
        assert.deepEqual((await Promise.all(results.map((r) => r.json()))).map((b) => b.text), ["words 1", "words 2", "words 3"]);
        assert.equal((await health(s.base)).busy, false);
    } finally { await s.close(); }
});

test("a slow decode times out, keeps the slot until it ends, and a queued request is never decoded", async () => {
    const fake = fakeRecognizer({ hold: true });
    const s = await start({ recognizer: fake, timeoutMs: 100 });
    try {
        const [running, queued] = await Promise.all([post(s.base, pcm(1)), post(s.base, pcm(1))]);
        assert.equal(running.status, 503);
        assert.equal(queued.status, 503);
        assert.deepEqual(await running.json(), { error: "timeout" });
        assert.deepEqual(s.logs.filter((l) => l.status === 503).map((l) => l.error).sort(), ["queue_timeout", "timeout"]);
        assert.equal((await health(s.base)).busy, true);
        fake.release();
        await until(async () => !(await health(s.base)).busy);
        assert.equal(fake.calls.length, 1);
        assert.ok(s.logs.some((l) => l.event === "late"));
        fake.hold = false;
        assert.equal((await post(s.base, pcm(1))).status, 200);
    } finally { await s.close(); }
});

test("a decode failure returns 500 and logs no detail", async () => {
    const s = await start({ recognizer: fakeRecognizer({ fail: "native error with secret words" }) });
    try {
        const response = await post(s.base, pcm(1));
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: "decode_failed" });
        assert.ok(!JSON.stringify(s.logs).includes("secret"));
        assert.equal((await health(s.base)).busy, false);
    } finally { await s.close(); }
});

test("a long turn is decoded in pieces of 15 s or less and joined", async () => {
    const fake = fakeRecognizer();
    const s = await start({ recognizer: fake });
    try {
        const response = await post(s.base, pcm(40, [[12, 12.5], [26, 26.5]]));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.text, "words 1 words 2 words 3");
        assert.equal(body.audioSec, 40);
        assert.equal(fake.calls.length, 3);
        assert.ok(fake.calls.every((n) => n <= 15 * RATE));
        assert.equal(fake.calls.reduce((a, b) => a + b, 0), 40 * RATE);
        assert.equal(s.logs.find((l) => l.event === "transcribe").segments, 3);
    } finally { await s.close(); }
});

test("unknown paths and wrong methods are refused", async () => {
    const s = await start({ recognizer: fakeRecognizer() });
    try {
        assert.equal((await fetch(`${s.base}/`)).status, 404);
        assert.equal((await fetch(`${s.base}/transcribe`)).status, 405);
        assert.equal((await fetch(`${s.base}/health`, { method: "POST" })).status, 405);
    } finally { await s.close(); }
});
