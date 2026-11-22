import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://body-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session-secret",
    ACCESS_PASSWORD: "correct horse battery", AUTH_ORIGIN: "https://assistant.test", CHAT_API_KEY: "fixture-chat",
});
globalThis.fetch = async (input) => { throw new Error(`Unexpected offline request to ${String(input instanceof Request ? input.url : input)}`); };

const { NextRequest } = await import("next/server");
const body = await import("../src/lib/http/body");
const limits = await import("../src/lib/http/limits");
const { proxy } = await import("../src/proxy");
const signIn = await import("../src/app/api/auth/route");
const chat = await import("../src/app/api/chat/route");
const { STT_MAX_BYTES } = await import("../src/lib/voice/stt-client");
const { MAX_FILE_SIZE_BYTES } = await import("../src/lib/types");
(await import("../src/lib/auth/session-epoch")).setSessionEpochSourceForTests(async () => null);

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) { await run(); passed++; console.log(`PASS ${name}`); }

/** A body stream that records how much was pulled and whether it was cancelled. */
function tracked(total: number, chunk = 16 * 1024) {
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (state.pulled >= total) { controller.close(); return; }
            const size = Math.min(chunk, total - state.pulled);
            state.pulled += size;
            controller.enqueue(new Uint8Array(size).fill(97));
        },
        cancel() { state.cancelled = true; },
    });
    return { stream, state };
}
const streamed = (url: string, stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    new Request(url, { method: "POST", body: stream, headers, duplex: "half" } as RequestInit);

await check("a declared length over the limit is refused before anything is read", async () => {
    const { stream, state } = tracked(1024 * 1024);
    await assert.rejects(body.readBodyCapped(streamed("https://assistant.test/api/x", stream, { "content-length": String(1024 * 1024) }), 1000), body.BodyTooLargeError);
    assert.ok(state.pulled <= 16 * 1024, `only the stream's own first chunk is buffered, read ${state.pulled}`);
});

await check("a body with no declared length is cancelled at the limit", async () => {
    const { stream, state } = tracked(10 * 1024 * 1024);
    const error = await body.readBodyCapped(streamed("https://assistant.test/api/x", stream), 64 * 1024).catch((e) => e);
    assert.ok(error instanceof body.BodyTooLargeError);
    assert.equal(error.message, "Request too large. The limit is 64 KB.");
    assert.ok(state.pulled <= 64 * 1024 + 16 * 1024, `read ${state.pulled} bytes`);
    assert.equal(state.cancelled, true);
});

await check("bad JSON is a 400 and an oversized body a 413, with the helper's message", async () => {
    const bad = await body.readJsonCapped(new Request("https://assistant.test/api/x", { method: "POST", body: "{nope" }), 100).catch((e) => e);
    const badResponse = body.bodyFailure(bad)!;
    assert.equal(badResponse.status, 400);
    assert.deepEqual(await badResponse.json(), { error: "The request body is not valid JSON." });
    const big = body.bodyFailure(new body.BodyTooLargeError(limits.CHAT_BODY_LIMIT))!;
    assert.equal(big.status, 413);
    assert.equal(body.bodyFailure(new Error("other")), null);
    assert.deepEqual(await body.readJsonCapped(new Request("https://assistant.test/api/x", { method: "POST", body: '{"a":1}' }), 100), { a: 1 });
});

await check("every limit is under Next's cut-off, so a body Next cut short is always too large", async () => {
    const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
    assert.match(config, /proxyClientMaxBodySize: "10mb"/);
    assert.equal(limits.NEXT_BODY_LIMIT, 10 * 1024 * 1024);
    for (const rule of limits.BODY_LIMIT_RULES) assert.ok(rule.limit < limits.NEXT_BODY_LIMIT, rule.path);
    assert.ok(limits.DEFAULT_BODY_LIMIT < limits.NEXT_BODY_LIMIT);
    const cut = streamed("https://assistant.test/api/chat", tracked(limits.NEXT_BODY_LIMIT).stream);
    await assert.rejects(body.readBodyCapped(cut), body.BodyTooLargeError, "the route's own limit is found from the URL");
});

await check("the table gives each route its limit", () => {
    assert.equal(limits.bodyLimit("/api/auth"), 64 * 1024);
    assert.equal(limits.bodyLimit("/api/auth/google"), limits.DEFAULT_BODY_LIMIT, "exact paths do not cover children");
    assert.equal(limits.bodyLimit("/api/cron/proactive"), 64 * 1024);
    assert.equal(limits.bodyLimit("/api/mcp/mcp"), 4 * 1024 * 1024);
    assert.equal(limits.bodyLimit("/api/chat/"), limits.CHAT_BODY_LIMIT);
    assert.equal(limits.bodyLimit("/api/chat/stream"), limits.CHAT_BODY_LIMIT);
    assert.equal(limits.bodyLimit("/api/voice/transcribe"), STT_MAX_BYTES);
    assert.equal(limits.bodyLimit("/api/todos"), limits.DEFAULT_BODY_LIMIT);
});

await check("a 7 MB file as base64 with a full-length message fits the chat limit; 8 MB does not", () => {
    const request = (bytes: number) => JSON.stringify({
        message: "é".repeat(10_000), channel: "web", conversationId: crypto.randomUUID(), thinking: false, search: false, agent: false,
        provider: "gemini", model: "gemini-3.5-flash-lite", freeOnly: false,
        file: { name: "scan-with-a-long-file-name.pdf", mimeType: "application/pdf", size: bytes, base64: Buffer.alloc(bytes).toString("base64") },
    });
    assert.ok(Buffer.byteLength(request(MAX_FILE_SIZE_BYTES)) <= limits.CHAT_BODY_LIMIT);
    assert.ok(Buffer.byteLength(request(8 * 1024 * 1024)) > limits.CHAT_BODY_LIMIT);
});

const proxied = (path: string, headers: Record<string, string>) => proxy(new NextRequest(`https://assistant.test${path}`, { method: "POST", headers }));
await check("the proxy refuses a declared oversized body before the sign-in check, on public and gated routes", async () => {
    const tooBig = await proxied("/api/auth", { "content-length": String(1024 * 1024) });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.headers.get("x-frame-options"), "DENY");
    assert.equal((await proxied("/api/agent/claim", { "content-length": String(65 * 1024) })).status, 413);
    assert.equal((await proxied("/api/todos", { "content-length": String(2 * 1024 * 1024) })).status, 413, "not a redirect to sign in");
    assert.equal((await proxied("/api/auth", { "content-length": "40" })).headers.get("x-middleware-next"), "1");
    assert.equal((await proxied("/api/chat", { "content-length": String(9_500_000) })).headers.get("x-middleware-next"), "1");
});

await check("sign-in reads at most 64 KB, even with no declared length", async () => {
    const { stream, state } = tracked(5 * 1024 * 1024);
    const res = await signIn.POST(new NextRequest("https://assistant.test/api/auth", { method: "POST", body: stream, duplex: "half" } as never));
    assert.equal(res.status, 413);
    assert.ok(state.pulled <= 80 * 1024);
});

await check("chat checks the real file size, not the size the client claims", async () => {
    const res = await chat.POST(new NextRequest("https://assistant.test/api/chat", {
        method: "POST", headers: { Authorization: "Bearer fixture-chat", "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Read this", channel: "discord", file: { name: "a.pdf", mimeType: "application/pdf", size: 10, base64: Buffer.alloc(MAX_FILE_SIZE_BYTES + 3).toString("base64") } }),
    }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /File too large\. Max 7 MB\./);
});

await check("no route reads a request body except through the capped helper", async () => {
    const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const files: string[] = [];
    const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (/\.tsx?$/.test(entry.name)) files.push(path);
        }
    };
    await walk(join(root, "app", "api"));
    await walk(join(root, "lib"));
    const direct = /\b(?:req|request)\.(?:json|text|formData|arrayBuffer|blob)\(\)/;
    const offenders: string[] = [];
    for (const file of files) {
        const rel = relative(root, file).replaceAll("\\", "/");
        if (rel === "lib/http/body.ts") continue;
        const lines = (await readFile(file, "utf8")).split("\n");
        lines.forEach((line, i) => { if (direct.test(line)) offenders.push(`${rel}:${i + 1}`); });
    }
    assert.deepEqual(offenders, []);
});

console.log(`Body limits: ${passed} checks passed; no network was used.`);
