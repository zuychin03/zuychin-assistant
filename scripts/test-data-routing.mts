import assert from "node:assert/strict";
import { assessDataRoute } from "../src/lib/ai/data-policy";
import { withModelObservationCollector, withModelDataClasses, configureModelDataPolicy, observeGeminiClient, beginModelObservation, beginExternalServiceObservation, type ModelCallObservation, type ExternalServiceObservation, type ObservedGeminiClient } from "../src/lib/ai/model-observations";
import { makeReplyTrace, mergeReplyTrace } from "../src/lib/ai/reply-trace";

const paid = { providerId: "gemini", modelId: "gemini-3.5-flash-lite", purpose: "chat", classes: ["personal"] as const };
assert.equal(assessDataRoute({ ...paid, classes: [...paid.classes], freeOnly: true }).allowed, false);
assert.equal(assessDataRoute({ ...paid, classes: ["unattended"] }).allowed, true);
assert.equal(assessDataRoute({ providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash", purpose: "chat", classes: ["personal"] }).allowed, true);
assert.equal(assessDataRoute({ providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash", purpose: "chat", classes: ["unattended"] }).allowed, false);
const partition = assessDataRoute({ providerId: "nvidia-nim", modelId: "nvidia/nemotron-3-embed-1b", purpose: "embedding", classes: ["knowledge", "unattended"] });
assert.equal(partition.allowed, true); assert.equal(partition.rule, "shared_embedding_partition");
assert.equal(assessDataRoute({ ...paid, providerId: "jev", classes: ["personal"] }).allowed, false);
assert.equal(assessDataRoute({ ...paid, classes: ["personal"] }).retention, "not_verified");
const calls: ModelCallObservation[] = [], services: ExternalServiceObservation[] = [];
let invoked = 0;
const raw = { models: { generateContent: async () => { invoked++; return { text: "Private answer", candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://private.invalid" } }] } }] }; } } } as unknown as ObservedGeminiClient;
await withModelObservationCollector(calls, async () => {
    configureModelDataPolicy(true);
    const blocked = observeGeminiClient(raw, { providerId: "gemini", purpose: "chat" });
    await assert.rejects(blocked.models.generateContent({ model: paid.modelId, contents: "Private input" }), /allowed model route/i);
    assert.equal(invoked, 0);
    const free = observeGeminiClient(raw, { providerId: "gemini-free", purpose: "search" });
    await withModelDataClasses(["public_search"], () => free.models.generateContent({ model: paid.modelId, contents: "Private query", config: { tools: [{ googleSearch: {} }] } }));
    const external = beginExternalServiceObservation({ providerId: "tavily", operation: "web_search" }); external.finish();
}, services, ["personal"]);
assert.deepEqual(calls[0].dataClasses, ["personal", "public_search"]);
assert.equal(calls[0].groundingRequested, true); assert.equal(calls[0].capabilities.grounding, true);
assert.deepEqual(services[0].dataClasses, ["personal", "public_search"]);
assert.doesNotMatch(JSON.stringify({ calls, services }), /Private|private\.invalid/);
const other: ModelCallObservation[] = [];
await Promise.all([
    withModelObservationCollector(calls, async () => { await new Promise(resolve => setTimeout(resolve, 5)); beginModelObservation({ providerId: "gemini", modelId: paid.modelId, purpose: "chat" }).finish(); }, [], ["personal"]),
    withModelObservationCollector(other, async () => { beginModelObservation({ providerId: "gemini", modelId: paid.modelId, purpose: "summary" }).finish(); }, [], ["knowledge"]),
]);
assert.deepEqual(calls[1].dataClasses, ["personal"]); assert.deepEqual(other[0].dataClasses, ["knowledge"]);
const trace = makeReplyTrace({ calls: [calls[1]], externalServices: [], origin: "interactive", freeOnly: false, startedAt: new Date().toISOString(), durationMs: 1, firstAnswerMs: null, background: "pending" });
assert.deepEqual(trace.dataClasses, ["personal"]);
const merged = mergeReplyTrace(trace, { ...trace, calls: other, background: "complete" });
assert.deepEqual(merged.dataClasses, ["personal", "knowledge"]);
console.log("Data routing: approved routes, free/paid policy, shared scheduled embeddings, retained personal search labels, grounding evidence and concurrent scopes passed.");
