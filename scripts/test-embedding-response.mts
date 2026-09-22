import assert from "node:assert/strict";

process.env.GEMINI_API_KEY = "test-key";
process.env.NVIDIA_NIM_API_KEY = "test-key";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-key";
const { embedText } = await import("../src/lib/ai/embeddings");
const { resolveEmbedding } = await import("../src/lib/ai/providers");
const ref = resolveEmbedding("nvidia/nemotron-3-embed-1b");
const originalFetch = globalThis.fetch;
let calls = 0;
try {
    for (const inputType of ["query", "passage"] as const) {
        globalThis.fetch = async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            assert.equal(body.model, ref.model.id);
            assert.equal(body.input_type, inputType);
            assert.ok(init?.signal);
            calls++;
            return Response.json({ data: [{ embedding: Array(ref.model.dimension).fill(0.25) }] });
        };
        assert.equal((await embedText(ref, "Synthetic retrieval test", inputType)).length, 2048);
    }
    for (const vector of [[], [1, 2], Array(2048).fill(0), Array(2048).fill(null), Array(2048).fill("0.25")]) {
        globalThis.fetch = async () => Response.json({ data: [{ embedding: vector }] });
        await assert.rejects(embedText(ref, "Synthetic retrieval test"), /Invalid 2048-dimensional/);
    }
    globalThis.fetch = async () => new Response("endpoint retired", { status: 410 });
    await assert.rejects(embedText(ref, "Synthetic retrieval test"), /NVIDIA NIM 410/);
    globalThis.fetch = async () => { assert.fail("An aborted request must not call the provider"); };
    await assert.rejects(embedText(ref, "Synthetic retrieval test", "passage", AbortSignal.abort()), { name: "AbortError" });
    const controller = new AbortController();
    globalThis.fetch = async (_url, init) => {
        assert.ok(init?.signal);
        controller.abort();
        init.signal.throwIfAborted();
        assert.fail("The caller's deadline must reach the provider request");
    };
    await assert.rejects(embedText(ref, "Synthetic retrieval test", "query", controller.signal), { name: "AbortError" });
    delete process.env.NVIDIA_NIM_API_KEY;
    globalThis.fetch = async () => { throw new Error("Must not send without a key"); };
    await assert.rejects(embedText(ref, "Synthetic retrieval test"), /Missing API key/);
    assert.equal(calls, 2);
    console.log("Embedding response checks passed: query/passage routing, dimensions, malformed vectors, cancellation, provider errors and missing keys.");
} finally {
    globalThis.fetch = originalFetch;
}
