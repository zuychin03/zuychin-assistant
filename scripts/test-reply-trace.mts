import assert from "node:assert/strict";
import { makeReplyTrace, mergeReplyTrace } from "../src/lib/ai/reply-trace";
import type { ModelCallObservation } from "../src/lib/ai/model-observations";

const usage = { promptTokens: 10, outputTokens: 3, totalTokens: 13, cachedInputTokens: null, completeness: "complete" as const };
const call = (id: string, extra: Partial<ModelCallObservation> = {}): ModelCallObservation => ({
    id, providerId: "fixture", modelId: "fixture-model", purpose: "chat", startedAt: "2026-09-28T00:00:00Z",
    durationMs: 100, firstAnswerMs: 20, status: "success", errorClass: null, httpStatus: null,
    usage, capabilities: { streaming: true, tools: false, vision: false, grounding: false }, ...extra,
});
const trace = (calls: ModelCallObservation[], background: "pending" | "complete" = "pending") => makeReplyTrace({
    origin: "interactive", freeOnly: true, startedAt: "2026-09-28T00:00:00Z",
    durationMs: 150, firstAnswerMs: 25, calls, externalServices: [], background,
});
let checks = 0;
function check(name: string, fn: () => void) { fn(); checks++; console.log("PASS " + name); }
check("unknown cache usage is not inferred", () => {
    const value = trace([call("a")]);
    assert.equal(value.usage.cachedInputTokens, null);
    assert.equal(value.retention, "not_verified");
    assert.equal(value.saved, false);
});
check("background merge keeps foreground calls and timing", () => {
    const value = mergeReplyTrace(trace([call("a")]), trace([call("b", { purpose: "extraction" })], "complete"));
    assert.equal(value.calls.length, 2);
    assert.equal(value.usage.totalTokens, 26);
    assert.equal(value.durationMs, 150);
    assert.equal(value.background, "complete");
});
check("repeated background writes cannot double count", () => {
    const value = mergeReplyTrace(trace([call("a")]), trace([call("a"), call("b")]));
    assert.equal(value.calls.length, 2);
    assert.equal(value.usage.totalTokens, 26);
});
check("late foreground write cannot undo finished background state", () => {
    const value = mergeReplyTrace(trace([call("a"), call("b")], "complete"), trace([call("a")]));
    assert.equal(value.background, "complete");
    assert.equal(value.calls.length, 2);
});
check("unknown helper usage makes totals explicitly incomplete", () => {
    const value = trace([call("a"), call("b", { purpose: "embedding", usage: { promptTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, completeness: "unavailable" } })]);
    assert.equal(value.usage.totalTokens, null);
    assert.equal(value.usage.completeness, "partial");
});
check("external search is recorded without invented model tokens", () => {
    const incoming = trace([call("a")]);
    incoming.externalServices = [{ id: "search", providerId: "tavily", operation: "web_search", startedAt: incoming.startedAt, durationMs: 5, status: "success", errorClass: null, httpStatus: null }];
    const value = mergeReplyTrace(incoming, incoming);
    assert.equal(value.externalServices.length, 1);
    assert.equal(value.usage.totalTokens, 13);
});
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://trace.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture" });
const fetchBefore = globalThis.fetch;
const { saveReplyTrace } = await import("../src/lib/ai/reply-trace-store");
let metadata: Record<string, unknown> = { artifacts: [{ id: "kept" }], knowledgeOnly: true };
let patches = 0;
const metadataSignals: AbortSignal[] = [];
globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/model_call_observations")) return Response.json([]);
    assert.ok(init?.signal, "Metadata operations require a bounded abort signal");
    metadataSignals.push(init.signal);
    assert.equal(url.searchParams.has("metadata"), false, "Metadata must not be encoded into URLs");
    if (url.pathname.endsWith("/rpc/assistant_reply_trace_save")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.p_message_id, "saved");
        patches++;
        if (patches === 1) {
            metadata = { ...metadata, replyTrace: mergeReplyTrace(undefined, trace([call("b")], "complete")) };
            return Response.json(false);
        }
        assert.deepEqual(body.p_expected_trace, metadata.replyTrace);
        metadata = { ...metadata, replyTrace: body.p_trace };
        return Response.json(true);
    }
    if (url.pathname.endsWith("/messages")) {
        assert.notEqual(init?.method, "PATCH");
        return Response.json({ metadata, user_profile_id: null });
    }
    throw new Error("Unexpected fixture request: " + url.pathname);
};
try {
    const saved = await saveReplyTrace("saved", trace([call("a")]));
    check("conditional metadata merge retries a concurrent background update", () => {
        assert.equal(patches, 2);
        assert.equal(saved.calls.length, 2);
        assert.equal(saved.background, "complete");
        assert.deepEqual(metadata.artifacts, [{ id: "kept" }]);
        assert.equal(metadata.knowledgeOnly, true);
        assert.equal(saved.saved, true);
        assert.ok(metadataSignals.length > 1 && metadataSignals.every((signal) => signal === metadataSignals[0]));
    });
    globalThis.fetch = async () => Response.json({ code: "PGRST205" }, { status: 404 });
    const failed = await saveReplyTrace("saved", trace([call("a")]));
    check("telemetry outage preserves a reply with unsaved state", () => {
        assert.equal(failed.saved, false);
        assert.equal(failed.calls.length, 1);
    });
    let aborted = false;
    globalThis.fetch = async (input, init) => {
        if (String(input).includes("model_call_observations")) return Response.json([]);
        assert.ok(init?.signal);
        const signal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
            const stop = () => { aborted = true; reject(new DOMException("Fixture deadline", "AbortError")); };
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
        });
    };
    const started = performance.now();
    const keepAlive = setTimeout(() => {}, 4000);
    const timedOut = await saveReplyTrace("saved", trace([call("a")]));
    clearTimeout(keepAlive);
    check("stalled metadata reads return unsaved within the telemetry deadline", () => {
        assert.equal(aborted, true);
        assert.equal(timedOut.saved, false);
        assert.ok(performance.now() - started < 3500);
    });
} finally { globalThis.fetch = fetchBefore; }
console.log(`Reply trace: ${checks} checks passed.`);
