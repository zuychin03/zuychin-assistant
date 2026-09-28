import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReplyTraceDetails } from "../src/app/home/reply-trace";
import type { ReplyTrace } from "../src/lib/ai/reply-trace";

const trace: ReplyTrace = {
    version: 1, origin: "interactive", dataClasses: ["personal", "knowledge"], freeOnly: true, retention: "not_verified",
    startedAt: "2026-09-28T00:00:00.000Z", durationMs: 1234, firstAnswerMs: null, saved: false, background: "pending",
    usage: { promptTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, completeness: "unavailable" },
    externalServices: [{ id: "service-1", providerId: "tavily", operation: "web_search", startedAt: "2026-09-28T00:00:00.000Z", durationMs: 100, status: "success", errorClass: null, httpStatus: 200 }],
    calls: [{ id: "call-1", providerId: "nvidia-nim", modelId: "fixture-model", purpose: "chat", startedAt: "2026-09-28T00:00:00.000Z",
        durationMs: 1200, firstAnswerMs: null, status: "unavailable", errorClass: "http", httpStatus: 404,
        usage: { promptTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, completeness: "unavailable" },
        capabilities: { streaming: false, tools: false, vision: false, grounding: false } }],
};
const html = renderToStaticMarkup(createElement(ReplyTraceDetails, { trace }));
assert.match(html, /1 observed model call/);
assert.match(html, /nvidia-nim/);
assert.match(html, /fixture-model/);
assert.match(html, /Unavailable/);
assert.match(html, /404/);
assert.match(html, /Unknown/);
assert.match(html, /Background work pending/);
assert.match(html, /Reply details have not been saved/);
assert.match(html, /Provider retention is not verified/);
assert.match(html, /tavily/);
assert.match(html, /1 observed external service call/);
assert.doesNotMatch(html, /retired|zero.retention|complete provider coverage/i);
const zero = renderToStaticMarkup(createElement(ReplyTraceDetails, { trace: { ...trace, saved: true, background: "complete", calls: [],
    usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, completeness: "complete" } } }));
assert.match(zero, /0 observed model calls/);
assert.match(zero, />0</);
assert.doesNotMatch(zero, /Reply details have not been saved/);
const injection = renderToStaticMarkup(createElement(ReplyTraceDetails, { trace: { ...trace, calls: [{ ...trace.calls[0], modelId: "<script>private</script>" }] } }));
assert.doesNotMatch(injection, /<script>/);
assert.match(injection, /&lt;script&gt;/);
const legacy: Partial<ReplyTrace> = { ...trace };
delete legacy.externalServices;
assert.doesNotMatch(renderToStaticMarkup(createElement(ReplyTraceDetails, { trace: legacy as ReplyTrace })), /observed external service/);
assert.match(renderToStaticMarkup(createElement(ReplyTraceDetails, { trace: { ...trace, background: "failed" } })), /Background work did not complete/);
const classified = renderToStaticMarkup(createElement(ReplyTraceDetails, { trace: { ...trace, calls: [{ ...trace.calls[0],
    dataClasses: ["personal", "knowledge", "public_search", "unattended"], groundingRequested: true,
    dataRoute: { tier: "free", allowed: true, retention: "not_verified", rule: "shared_embedding_partition" } }] } }));
assert.match(classified, /Data classes: personal, knowledge, public search, unattended/);
assert.match(classified, /returned source evidence not observed/);
assert.match(classified, /existing shared knowledge partition and may be free/);
console.log("Reply trace UI: 22 assertions passed.");
