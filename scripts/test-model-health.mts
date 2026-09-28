import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://health-fixture.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    CHAT_API_KEY: "fixture-chat", AUTH_SESSION_SECRET: "fixture-session", NVIDIA_NIM_API_KEY: "fixture-nim", GEMINI_API_KEY: "fixture-gemini",
});
const calls: { url: URL; method: string; body: unknown }[] = [];
let databaseError: { code: string; message: string } | null = null;
let aggregates: Record<string, unknown>[] = [];
let inserted: Record<string, unknown>[] = [];
let hangWrite = false;
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    assert.equal(url.hostname, "health-fixture.supabase.co", "No model endpoint may be called");
    calls.push({ url, method, body });
    if (databaseError) return Response.json(databaseError, { status: 503 });
    if (url.pathname === "/rest/v1/model_call_observations") {
        assert.equal(method, "POST");
        const headers = new Headers(init?.headers ?? request?.headers);
        assert.match(headers.get("Prefer") ?? "", /ignore-duplicates/);
        if (hangWrite) return await new Promise<Response>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Fixture timeout was not cancelled")), 5000);
            const signal = init?.signal ?? request?.signal;
            signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        inserted = body;
        return new Response(null, { status: 201 });
    }
    assert.equal(url.pathname, "/rest/v1/rpc/assistant_model_health");
    return Response.json(aggregates);
};
const { persistModelObservations, getModelHealth } = await import("../src/lib/ai/model-health");
const { GET } = await import("../src/app/api/admin/model-health/route");
const { NextRequest } = await import("next/server");
const request = (auth = true, query = "") => new NextRequest(`https://fixture.invalid/api/admin/model-health${query}`, {
    headers: auth ? { authorization: "Bearer fixture-chat" } : {},
});
const valid = {
    id: "10000000-0000-4000-8000-000000000001", providerId: "nvidia-nim", modelId: "z-ai/glm-5.3-flash", purpose: "chat" as const,
    startedAt: "2026-09-28T00:00:00.000Z", durationMs: 2450, firstAnswerMs: 250, status: "success" as const,
    errorClass: null, httpStatus: 200,
    usage: { promptTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: null, completeness: "complete" as const },
    capabilities: { streaming: true, tools: false, vision: false, grounding: false },
};
const aggregate = {
    provider_id: "nvidia-nim", model_id: "z-ai/glm-5.3-flash", total_calls: 5020, successful_calls: 5017, failed_calls: 2, aborted_calls: 1, unknown_calls: 0,
    latest_at: "2026-09-28T00:00:00.000Z", latest_status: "unavailable", latest_error_class: "http", latest_http_status: 404,
    latest_duration_ms: 1200, latest_first_answer_ms: null, last_success_at: "2026-09-01T00:00:00.000Z",
    median_success_duration_ms: 2450, median_first_answer_ms: 250, first_observed_at: "2026-08-01T00:00:00.000Z",
    streaming_observed_at: "2026-09-01T00:00:00.000Z", tools_observed_at: null, vision_observed_at: null, grounding_observed_at: null,
    purposes: ["chat"],
};
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
    calls.length = 0; inserted = []; aggregates = []; databaseError = null; hangWrite = false;
    await run(); passed++; console.log(`PASS ${name}`);
}
await check("auth is required before metadata access", async () => {
    assert.equal((await GET(request(false))).status, 401);
    assert.equal(calls.length, 0);
});
await check("API returns current catalogue with honest unknown observations", async () => {
    const response = await GET(request());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const result = await response.json();
    assert.equal(result.storage.available, true);
    assert(result.models.length > 20);
    const model = result.models.find((row: { providerId: string; modelId: string }) => row.providerId === valid.providerId && row.modelId === valid.modelId);
    assert.equal(model.health, null);
    assert.equal(model.capabilities.streaming.observedAt, null);
    assert.equal(model.catalogue, "current");
    assert(result.models.some((row: { configured: boolean }) => !row.configured));
});
await check("aggregate RPC preserves old real last success, nullable timings and unavailable status", async () => {
    aggregates = [aggregate];
    const result = await getModelHealth();
    const model = result.models.find(row => row.providerId === valid.providerId && row.modelId === valid.modelId)!;
    assert.equal(model.health?.lastSuccessfulAt, aggregate.last_success_at);
    assert.equal(model.health?.latestStatus, "unavailable");
    assert.equal(model.health?.latestFirstAnswerMs, null);
    assert.equal(model.health?.totalCalls, 5020);
    assert.equal(model.capabilities.streaming.observedAt, aggregate.streaming_observed_at);
    assert.equal(model.capabilities.tools.observedAt, null);
    assert.equal(calls.length, 1);
    assert(!calls[0].url.searchParams.has("limit"));
});
await check("configured speech stays current with unknown capabilities until observed", async () => {
    const current = (await getModelHealth()).models.find(row => row.kind === "speech")!;
    assert.equal(current.providerId, "gemini"); assert.equal(current.catalogue, "current"); assert.equal(current.configured, true); assert.equal(current.free, false);
    assert.equal(current.health, null); assert.equal(current.capabilities.streaming.observedAt, null);
    aggregates = [{ ...aggregate, provider_id: "gemini", model_id: current.modelId, purposes: ["speech"] }];
    const observed = (await getModelHealth()).models.find(row => row.modelId === current.modelId)!;
    assert.equal(observed.kind, "speech"); assert.equal(observed.catalogue, "current"); assert.equal(observed.configured, true);
    assert.deepEqual(observed.health?.purposes, ["speech"]);
    delete process.env.GEMINI_API_KEY;
    assert.equal((await getModelHealth()).models.find(row => row.kind === "speech")!.configured, false);
    process.env.GEMINI_API_KEY = "fixture-gemini";
});
await check("models absent from catalogue remain historical rather than retired", async () => {
    aggregates = [{ ...aggregate, model_id: "older-model", latest_status: "success" }];
    const model = (await getModelHealth()).models.find(row => row.modelId === "older-model")!;
    assert.equal(model.catalogue, "historical");
    assert.equal(model.health?.latestStatus, "success");
});
await check("store writes only validated metadata and assistant scope", async () => {
    const result = await persistModelObservations([{ ...valid, prompt: "SECRET CONTENT", rawError: "Bearer SECRET", extra: { text: "PRIVATE" } }], {
        conversationId: "20000000-0000-4000-8000-000000000001", messageId: "30000000-0000-4000-8000-000000000001", userProfileId: "40000000-0000-4000-8000-000000000001",
    });
    assert.equal(result.stored, 1);
    assert.equal(result.dropped, 0);
    assert.equal(inserted[0].execution_scope, "assistant");
    assert.equal(inserted[0].prompt_tokens, 100);
    assert.equal(inserted[0].cached_input_tokens, null);
    assert.equal(inserted[0].tools_observed, false);
    assert(!JSON.stringify(inserted).includes("SECRET"));
    assert(!JSON.stringify(inserted).includes("PRIVATE"));
});
await check("unknown usage is preserved as null without invented zeroes", async () => {
    await persistModelObservations([{ ...valid, usage: { promptTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, completeness: "unavailable" } }]);
    assert.equal(inserted[0].total_tokens, null);
    assert.equal(inserted[0].usage_completeness, "unavailable");
});
for (const patch of [
    { id: "not-a-uuid" }, { durationMs: -1 }, { durationMs: Infinity }, { firstAnswerMs: 3000 }, { providerId: "Bearer secret" },
    { purpose: "council" }, { status: "healthy" }, { errorClass: "raw secret" }, { startedAt: "invalid" }, { httpStatus: 999 },
    { capabilities: { streaming: "true" } }, { usage: { ...valid.usage, promptTokens: -1 } }, { status: "retired", httpStatus: 404 },
]) await check(`invalid observation is dropped: ${Object.keys(patch)[0]}`, async () => {
    const result = await persistModelObservations([{ ...valid, ...patch }]);
    assert.equal(result.stored, 0);
    assert.equal(result.dropped, 1);
    assert.equal(calls.length, 0);
});
await check("invalid correlation identifiers never enter storage", async () => {
    const result = await persistModelObservations([valid], { conversationId: "raw secret" });
    assert.equal(result.stored, 0);
    assert.equal(calls.length, 0);
});
await check("a missing migration stays explicit while the catalogue remains visible", async () => {
    databaseError = { code: "PGRST202", message: "SECRET database details" };
    const response = await GET(request());
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.storage.reason, "migration_required");
    assert(result.models.length > 0);
    assert(!JSON.stringify(result).includes("SECRET"));
});
await check("persistence failures do not throw or reveal database text", async () => {
    databaseError = { code: "08006", message: "SECRET connection details" };
    const result = await persistModelObservations([valid]);
    assert.equal(result.available, false);
    assert.equal(result.stored, 0);
    assert(!JSON.stringify(result).includes("SECRET"));
});
await check("database outage is distinct from migration and empty history", async () => {
    databaseError = { code: "08006", message: "database offline" };
    const response = await GET(request());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).storage.reason, "unavailable");
});
await check("missing observation table is a safe persistence activation error", async () => {
    databaseError = { code: "PGRST205", message: "private schema text" };
    const result = await persistModelObservations([valid]);
    assert.equal(result.available, false);
    assert.equal(result.error, "migration_required");
});
await check("unexpected aggregate fields are not exposed", async () => {
    aggregates = [{ ...aggregate, prompt: "SECRET PROMPT", raw_error: "SECRET KEY" }];
    const report = await getModelHealth();
    assert.equal(report.storage.available, true);
    assert(!JSON.stringify(report).includes("SECRET"));
});
await check("malformed aggregate data is an outage rather than invented health", async () => {
    aggregates = [{ ...aggregate, latest_status: "healthy-forever" }];
    const report = await getModelHealth();
    assert.equal(report.storage.available, false);
    assert(report.models.every(model => model.health === null));
});
await check("unsupported scope cannot request Council or another data surface", async () => {
    assert.equal((await GET(request(true, "?scope=council"))).status, 400);
    assert.equal(calls.length, 0);
});
await check("telemetry writes have a deadline and never hold chat indefinitely", async () => {
    hangWrite = true;
    const start = performance.now();
    const result = await persistModelObservations([valid]);
    assert.equal(result.available, false);
    assert(performance.now() - start < 4000);
});
await check("SQL grants only service access and aggregates complete retained history", async () => {
    const sql = await readFile(new URL("./migrations/v6-model-health.sql", import.meta.url), "utf8");
    assert.match(sql, /enable row level security/i);
    assert.match(sql, /revoke all on public\.model_call_observations from public, anon, authenticated/i);
    assert.match(sql, /grant select, insert on public\.model_call_observations to service_role/i);
    assert.match(sql, /security invoker set search_path = pg_catalog, public/i);
    assert.match(sql, /revoke all on function public\.assistant_model_health\(\) from public, anon, authenticated/i);
    assert.match(sql, /max\(o\.started_at\) filter \(where o\.status = 'success'\)/i);
    assert.doesNotMatch(sql, /\blimit\s+\d|interval\s+'\d/i);
    assert.doesNotMatch(sql, /\b(prompt|raw_error|response_body|api_key)\s+(text|jsonb)/i);
});
console.log(`Model health: ${passed} passed.`);
