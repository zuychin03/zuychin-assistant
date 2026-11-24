// Offline checks for the V8 free providers (docs/V8_FREE_PROVIDERS_PLAN.md C1 and C2): Cloudflare's account id and
// key check, the LlamaParse key check, the Cloudflare listing, the provider rest state and how the catalogue run uses
// rest, per-provider probe caps, untested kinds and seeded providers. No live services.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

for (const name of ["CLOUDFLARE_AI_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "LLAMA_CLOUD_API_KEY", "PROVIDER_KEYS_SECRET", "CREDENTIALS_DIRECTORY"]) delete process.env[name];
Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://free-providers-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session", ACCESS_PASSWORD: "fixture-access-password",
    APP_TIMEZONE: "Australia/Sydney",
});
globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`Unexpected request to ${new URL(input instanceof Request ? input.url : String(input)).hostname}`);
}) as typeof fetch;

const providersModule = await import("../src/lib/ai/providers");
const { PROVIDERS, getProviderApiKey, isProviderAvailable, providerAccountId, providers, splitAccountKey, withAccount } = providersModule;
const { checkProviderKey } = await import("../src/lib/ai/provider-keys/check");
const { setProviderKeySnapshotForTests } = await import("../src/lib/ai/provider-keys/snapshot");
const { decryptApiKey, deriveKey } = await import("../src/lib/ai/provider-keys/crypto");
const { providerKeysView, saveProviderKey } = await import("../src/lib/ai/provider-keys/admin");
const { listProviderModels, parseCloudflareModels, selectAllDiscoverable } = await import("../src/lib/ai/catalogue/sources");
const rest = await import("../src/lib/ai/provider-rest");
const { executeDiscovery } = await import("../src/lib/ai/catalogue/run");
type ProviderConfig = import("../src/lib/ai/providers").ProviderConfig;
type KeyAdminDeps = import("../src/lib/ai/provider-keys/admin").KeyAdminDeps;
type StoredKeyRow = import("../src/lib/ai/provider-keys/store").StoredKeyRow;
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;
type ListedModel = import("../src/lib/ai/catalogue/sources").ListedModel;
type ListingResult = import("../src/lib/ai/catalogue/sources").ListingResult;
type DiscoveryDeps = import("../src/lib/ai/catalogue/run").DiscoveryDeps;
type RunSummary = import("../src/lib/ai/catalogue/run").RunSummary;
type ProbeResult = import("../src/lib/ai/catalogue/probe").ProbeResult;
type TypedProbeResult = import("../src/lib/ai/catalogue/probe-typed").TypedProbeResult;

let passed = 0;
async function check(name: string, test: () => void | Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const TOKEN = "cf-fixture-token_0123456789";
const cloudflare = PROVIDERS.find((entry) => entry.id === "cloudflare")!;
const llamaparse = PROVIDERS.find((entry) => entry.id === "llamaparse")!;

function recordingFetch(answers: Record<string, { status: number; body?: unknown }>, seen: { url: string; auth?: string }[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
        const match = Object.entries(answers).find(([prefix]) => url.startsWith(prefix));
        if (!match) throw new Error(`No fixture for ${url}`);
        return new Response(JSON.stringify(match[1].body ?? {}), { status: match[1].status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
}

// ---- C1: account id, keys and checks ----

await check("a dashboard key splits into account id and token only when it starts with a 32-character hex id", () => {
    assert.deepEqual(splitAccountKey(`${ACCOUNT.toUpperCase()}:${TOKEN}`), { accountId: ACCOUNT, apiKey: TOKEN });
    assert.deepEqual(splitAccountKey(TOKEN), { accountId: null, apiKey: TOKEN });
    assert.deepEqual(splitAccountKey("abc:def-token-value"), { accountId: null, apiKey: "abc:def-token-value" }, "a short head is part of the key");
});

await check("Cloudflare needs both a token and an account id; without the id it says so and stays unavailable", () => {
    setProviderKeySnapshotForTests({});
    assert.equal(cloudflare.baseUrl, "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1");
    assert.equal(isProviderAvailable(withAccount(cloudflare)), false, "no token");
    assert.equal(withAccount(cloudflare).unavailableReason, undefined, "no token reads as Missing key, not as a missing id");

    process.env.CLOUDFLARE_AI_TOKEN = TOKEN;
    const noId = withAccount(cloudflare);
    assert.match(noId.unavailableReason ?? "", /No account id/);
    assert.equal(isProviderAvailable(noId), false);
    assert.equal(isProviderAvailable(cloudflare), false, "an unfilled base URL is never callable");

    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
    const ready = withAccount(cloudflare);
    assert.equal(ready.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`);
    assert.equal(isProviderAvailable(ready), true);
    assert.equal(getProviderApiKey(cloudflare), TOKEN);
});

await check("a dashboard key carrying the id wins over the env vars, and providers() rebuilds when keys change", () => {
    setProviderKeySnapshotForTests({ cloudflare: `${OTHER_ACCOUNT}:dashboard-token-0123` });
    assert.equal(providerAccountId(cloudflare), OTHER_ACCOUNT);
    assert.equal(getProviderApiKey(cloudflare), "dashboard-token-0123", "only the token goes in Authorization");
    assert.equal(providers().find((entry) => entry.id === "cloudflare")!.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${OTHER_ACCOUNT}/ai/v1`);
    setProviderKeySnapshotForTests({ cloudflare: "dashboard-token-0123" });
    assert.equal(providerAccountId(cloudflare), ACCOUNT, "a bare dashboard token falls back to CLOUDFLARE_ACCOUNT_ID");
    assert.equal(providers().find((entry) => entry.id === "cloudflare")!.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`);
    setProviderKeySnapshotForTests({});
});

await check("the Cloudflare key check verifies the token, then the account id, and never sends the id as the token", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const ok = await checkProviderKey(cloudflare, `${OTHER_ACCOUNT}:${TOKEN}`, recordingFetch({
        "https://api.cloudflare.com/client/v4/user/tokens/verify": { status: 200, body: { result: { status: "active" } } },
        [`https://api.cloudflare.com/client/v4/accounts/${OTHER_ACCOUNT}/ai/models/search?per_page=1`]: { status: 200, body: { result: [] } },
    }, seen));
    assert.equal(ok.outcome, "ok");
    assert.deepEqual(seen.map((entry) => entry.auth), [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);

    const badToken = await checkProviderKey(cloudflare, `${ACCOUNT}:${TOKEN}`, recordingFetch({ "https://api.cloudflare.com/client/v4/user/tokens/verify": { status: 400 } }));
    assert.equal(badToken.outcome, "rejected", "a malformed token answers 400");
    const wrongAccount = await checkProviderKey(cloudflare, `${ACCOUNT}:${TOKEN}`, recordingFetch({
        "https://api.cloudflare.com/client/v4/user/tokens/verify": { status: 200 },
        "https://api.cloudflare.com/client/v4/accounts/": { status: 403, body: { errors: [{ code: 10000, message: "Authentication error" }] } },
    }));
    assert.equal(wrongAccount.outcome, "rejected");
    assert.match(wrongAccount.message, /not on that account id/);

    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const noId = await checkProviderKey(cloudflare, TOKEN, recordingFetch({}));
    assert.equal(noId.outcome, "unknown");
    assert.match(noId.message, /No account id/);
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
});

await check("the LlamaParse key check reads the project list on LlamaCloud", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const result = await checkProviderKey(llamaparse, "llx-fixture-key-0123", recordingFetch({ "https://api.cloud.llamaindex.ai/api/v1/projects": { status: 401 } }, seen));
    assert.equal(result.outcome, "rejected");
    assert.equal(seen[0].url, "https://api.cloud.llamaindex.ai/api/v1/projects");
    assert.equal(seen[0].auth, "Bearer llx-fixture-key-0123");
});

const master = randomBytes(32);
function keyFixture() {
    const rows = new Map<string, StoredKeyRow>();
    const checked: string[] = [];
    const deps: KeyAdminDeps = {
        store: {
            async read() { return { ok: true, rows: [...rows.values()] }; },
            async save(providerId, keyRef, ciphertext) { rows.set(providerId, { providerId, keyRef, ciphertext, updatedAt: "" }); return "ok"; },
            async remove(providerId) { rows.delete(providerId); return "ok"; },
        },
        masters: () => ({ current: { ok: true, key: master, source: "env" }, previous: null }),
        check: async (_provider, apiKey) => { checked.push(apiKey); return { outcome: "ok", status: 200, ms: 1, message: "fixture" }; },
        notify: async () => {},
        startCatalogueCheck: async () => "started",
        now: () => new Date("2026-11-25T01:00:00.000Z"),
    };
    return { rows, checked, deps, stored: (id: string) => decryptApiKey(deriveKey(master), id, rows.get(id)!.ciphertext) };
}

await check("saving the Cloudflare token stores the account id with it, encrypted, and the view never shows the id", async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    setProviderKeySnapshotForTests({});
    const { deps, checked, stored } = keyFixture();
    const missing = await saveProviderKey({ providerId: "cloudflare", apiKey: TOKEN, accountId: "" }, deps);
    assert.equal(missing.status, 400);
    assert.match(String(missing.body.error), /account id/);
    const bad = await saveProviderKey({ providerId: "cloudflare", apiKey: TOKEN, accountId: "not-an-id" }, deps);
    assert.equal(bad.status, 400);

    const saved = await saveProviderKey({ providerId: "cloudflare", apiKey: TOKEN, accountId: ACCOUNT.toUpperCase() }, deps);
    assert.equal(saved.status, 200);
    assert.equal(stored("cloudflare"), `${ACCOUNT}:${TOKEN}`);
    assert.deepEqual(checked, [`${ACCOUNT}:${TOKEN}`], "the check sees the id it must test");
    const view = providerKeysView().providers.find((entry) => entry.id === "cloudflare")!;
    assert.equal(view.accountIdSet, true);
    assert.equal(view.available, true);
    assert.equal(view.lastFour, TOKEN.slice(-4));
    assert.ok(!JSON.stringify(view).includes(ACCOUNT), "the id stays server side");

    const replaced = await saveProviderKey({ providerId: "cloudflare", apiKey: "cf-new-token-9876543210" }, deps);
    assert.equal(replaced.status, 200);
    assert.equal(stored("cloudflare"), `${ACCOUNT}:cf-new-token-9876543210`, "a new token alone keeps the saved id");
    setProviderKeySnapshotForTests({});
});

await check("other providers store their key unchanged", async () => {
    const { deps, stored } = keyFixture();
    assert.equal((await saveProviderKey({ providerId: "llamaparse", apiKey: "llx-fixture-key-0123", accountId: ACCOUNT }, deps)).status, 200);
    assert.equal(stored("llamaparse"), "llx-fixture-key-0123");
    setProviderKeySnapshotForTests({});
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
});

// ---- C2: the Cloudflare listing ----

const SEARCH = {
    success: true,
    result: [
        { name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", description: "Llama", task: { name: "Text Generation" }, properties: [{ property_id: "context_window", value: "24000" }, { property_id: "function_calling", value: "true" }] },
        { name: "@cf/meta/llama-3.2-11b-vision-instruct", task: { name: "Text Generation" }, properties: [{ property_id: "vision", value: "true" }, { property_id: "context_window", value: 128000 }] },
        { name: "@cf/zai-org/glm-5.3", task: { name: "Text Generation" }, properties: [{ property_id: "require_workers_paid", value: "true" }] },
        { name: "@cf/cloudflare/clef-flash", task: { name: "Text Generation" }, properties: [] },
        { name: "@cf/meta/llama-guard-3-8b", task: { name: "Text Generation" }, properties: [] },
        { name: "@cf/baai/bge-m3", task: { name: "Text Embeddings" }, properties: [] },
        { name: "@cf/google/embeddinggemma-2", task: { name: "Multimodal Embeddings" }, properties: [] },
        { name: "@cf/baai/bge-reranker-base", task: { name: "Text Classification" }, properties: [] },
        { name: "@cf/huggingface/distilbert-sst-2-int8", task: { name: "Text Classification" }, properties: [] },
        { name: "@cf/black-forest-labs/flux-2-klein-4b", task: { name: "Text-to-Image" }, properties: [] },
        { name: "@cf/black-forest-labs/flux-1-schnell", task: { name: "Text-to-Image" }, properties: [] },
        { name: "@cf/deepgram/aura-2-en", task: { name: "Text-to-Speech" }, properties: [] },
        { name: "@cf/openai/whisper-large-v3-turbo", task: { name: "Automatic Speech Recognition" }, properties: [] },
        { name: "@cf/deepgram/flux", task: { name: "Automatic Speech Recognition" }, properties: [] },
        { name: "@cf/meta/m2m100-1.2b", task: { name: "Translation" }, properties: [] },
        { name: "@cf/moondream/moondream3.1-9B-A2B", task: { name: "Image-to-Text" }, properties: [] },
    ],
    result_info: { count: 16, page: 1, per_page: 100, total_count: 338 },
};

await check("the Cloudflare listing maps tasks to kinds, finds Clef and the reranker by id, and leaves out paid and unwanted models", () => {
    const models = parseCloudflareModels(SEARCH);
    const kinds = Object.fromEntries(models.map((model) => [model.modelId, model.kind]));
    assert.equal(kinds["@cf/zai-org/glm-5.3"], undefined, "Workers Paid models are not listed at all");
    assert.equal(kinds["@cf/meta/llama-3.3-70b-instruct-fp8-fast"], "chat");
    assert.equal(kinds["@cf/cloudflare/clef-flash"], "decision");
    assert.equal(kinds["@cf/baai/bge-reranker-base"], "rerank");
    assert.equal(kinds["@cf/huggingface/distilbert-sst-2-int8"], null);
    assert.equal(kinds["@cf/google/embeddinggemma-2"], "embedding");
    assert.equal(kinds["@cf/black-forest-labs/flux-2-klein-4b"], "image");
    assert.equal(kinds["@cf/black-forest-labs/flux-1-schnell"], null, "V8 plan Decision 2");
    assert.equal(kinds["@cf/deepgram/aura-2-en"], "speech");
    assert.equal(kinds["@cf/openai/whisper-large-v3-turbo"], "transcription");
    assert.equal(kinds["@cf/deepgram/flux"], null, "websocket only");
    assert.equal(kinds["@cf/meta/m2m100-1.2b"], "translate");
    assert.equal(kinds["@cf/moondream/moondream3.1-9B-A2B"], null);
    const llama = models.find((model) => model.modelId === "@cf/meta/llama-3.3-70b-instruct-fp8-fast")!;
    assert.equal(llama.contextTokens, 24000);
    assert.equal(llama.listedTools, true);
    assert.deepEqual(llama.inputs, ["Text"], "no vision step for a text-only model");
    assert.deepEqual(models.find((model) => model.modelId === "@cf/meta/llama-3.2-11b-vision-instruct")!.inputs, ["Text", "Image"]);
    assert.ok(models.every((model) => model.free && model.mayTrain === false));
    assert.equal(models.find((model) => model.modelId === "@cf/baai/bge-m3")!.familyId, "bge-m3");
    const chat = selectAllDiscoverable(models, cloudflare.discovery!, new Set(), ["chat"]).map((model) => model.modelId);
    assert.ok(!chat.includes("@cf/meta/llama-guard-3-8b"), "guard models are excluded");
});

await check("the listing calls the model search under the account, pages until a short page and reports Cloudflare's error text", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`;
    const result = await listProviderModels({ ...cloudflare, baseUrl: base }, cloudflare.discovery!, TOKEN, {
        fetchImpl: recordingFetch({ [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/models/search`]: { status: 200, body: SEARCH } }, seen),
    });
    assert.ok(result.ok);
    assert.equal(seen.length, 1, "16 of 100 is a short page");
    assert.equal(seen[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/models/search?per_page=100&page=1`);
    assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
    const failed = await listProviderModels({ ...cloudflare, baseUrl: base }, cloudflare.discovery!, TOKEN, {
        fetchImpl: recordingFetch({ "https://api.cloudflare.com/": { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } } }),
    });
    assert.deepEqual(failed, { ok: false, status: 403, error: "Authentication error" });
    const seeded = await listProviderModels(llamaparse, llamaparse.discovery!, "llx-key", { fetchImpl: recordingFetch({}) });
    assert.equal(seeded.ok, false, "a seeded provider is never listed");
});

// ---- C2: the rest state ----

const NOW = Date.parse("2026-11-25T03:00:00.000Z");
const QUOTA_BODY = '{"errors":[{"message":"AiError: You have used up your daily free allocation of 10,000 neurons. Please upgrade.","code":3036}],"success":false}';

await check("only Cloudflare's daily allowance reply starts a rest, until the next 00:00 UTC", () => {
    assert.equal(rest.quotaRestUntil("cloudflare", 429, QUOTA_BODY, NOW), Date.parse("2026-11-26T00:00:00.000Z"));
    assert.equal(rest.quotaRestUntil("cloudflare", 429, '{"errors":[{"message":"Capacity temporarily exceeded, please try again.","code":3040}]}', NOW), null, "busy is not spent");
    assert.equal(rest.quotaRestUntil("cloudflare", 403, QUOTA_BODY, NOW), null);
    assert.equal(rest.quotaRestUntil("groq", 429, QUOTA_BODY, NOW), null);
    assert.equal(rest.quotaRestUntil("llamaparse", 402, null, NOW), Date.parse("2026-12-01T00:00:00.000Z"));
    assert.equal(rest.quotaRestFromSteps("cloudflare", { chat: { httpStatus: 200, detail: null }, tools: { httpStatus: 429, detail: QUOTA_BODY } }, NOW), Date.parse("2026-11-26T00:00:00.000Z"));
});

await check("a rest is stored, sends one notice per period in AEDT and UTC, and ends at its time", async () => {
    rest.setProviderRestForTests({});
    const saves: unknown[] = [], notices: string[] = [];
    let stored: Record<string, unknown> | null = null;
    const io = {
        load: async () => stored as never,
        save: async (state: Record<string, unknown>) => { stored = state; saves.push(state); },
        notify: async (text: string) => { notices.push(text); },
    };
    const until = Date.parse("2026-11-26T00:00:00.000Z");
    const input = { providerId: "cloudflare", label: "Cloudflare Workers AI", untilMs: until, reason: "daily free allocation", kinds: ["Rerank", "decision"] };
    assert.equal(await rest.enterProviderRest(input, io, NOW), true);
    assert.equal(await rest.enterProviderRest(input, io, NOW + 60_000), false, "a second reply from the same spent allowance");
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Cloudflare Workers AI is resting\*\* until 26\/11\/2026, 11:00 AEDT \(00:00 UTC\)/);
    assert.match(notices[0], /Rerank, decision use their other routes until then\./);
    assert.equal(saves.length, 1);
    assert.equal(rest.restingUntil("cloudflare", NOW), until);
    assert.equal(rest.restingUntil("cloudflare", until), null, "the reset ends it");
    assert.deepEqual(Object.keys(rest.providerRestSnapshot(until + 1)), []);
    assert.equal(await rest.enterProviderRest({ ...input, untilMs: Date.parse("2026-11-27T00:00:00.000Z") }, io, until + 60_000), true, "the next day's rest is a new period");
    assert.equal(notices.length, 2);
    rest.setProviderRestForTests({});
});

// ---- C2: the catalogue run ----

const DAY = 24 * 60 * 60_000;
const START = Date.parse("2026-11-25T04:10:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const cf: ProviderConfig = {
    ...cloudflare, baseUrl: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`,
    discovery: { ...cloudflare.discovery!, maxProbes: 1 },
};
const seedy: ProviderConfig = {
    id: "seedy", label: "Seedy", kind: "rest", baseUrl: "https://seedy.invalid", apiKeyEnv: "SEEDY_FIXTURE_KEY",
    discovery: { source: "seeded", include: "all", pricing: "all-free", probeEveryDays: 30, kinds: { embedding: { include: "all" } } },
    chatModels: [], embeddingModels: [],
};

function listed(modelId: string, kind: ListedModel["kind"] = "chat"): ListedModel {
    return {
        modelId, label: modelId, description: null, developer: null, free: true, contextTokens: 8000, maxOutputTokens: null,
        inputs: kind === "chat" ? ["Text"] : [], listedTools: null, listedStructured: null, listedThinking: null, mayTrain: false,
        chat: kind === "chat", kind, expiresAt: null, voices: [], familyId: modelId,
    };
}

function row(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.slice(overrides.modelId.lastIndexOf("/") + 1),
        description: null, developer: null, free: true, metered: false, mayTrain: false,
        contextTokens: 8000, maxOutputTokens: null, inputs: ["Text"], listedTools: null, listedStructured: null, listedThinking: null,
        probeStatus: "passed", probeAttempts: 0, probedAt: iso(START - 8 * DAY), probeChatMs: 900,
        supportsTools: true, supportsSearch: true, supportsVision: false, supportsThinking: null, supportsStructured: null,
        firstSeenAt: iso(START - 30 * DAY), lastSeenAt: iso(START - DAY), missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: iso(START - 20 * DAY),
        ...overrides,
    } as CatalogueRow;
}

// Cast: the probe result shape grows with V8 parts built alongside; the run reads these fields only.
function chatResult(status: ProbeResult["status"], step: { httpStatus: number | null; detail: string | null }): ProbeResult {
    const outcome = status === "passed" ? "pass" : "transient";
    const one = { outcome, ms: 50, ...step };
    return { status, retired: false, chatMs: 900, supportsTools: true, supportsSearch: true, supportsVision: null, steps: { chat: one, tools: one, forced: one, vision: { ...one, outcome: "skipped" } } } as unknown as ProbeResult;
}

function typedResult(): TypedProbeResult {
    return { status: "passed", retired: false, retiredAt: null, ms: 100, dimension: 1024, spaceOf: null, traits: {}, steps: { embed: { outcome: "pass", httpStatus: 200, ms: 100, detail: null } } } as TypedProbeResult;
}

function harness(options: { rows: CatalogueRow[]; providers: ProviderConfig[]; listings?: Record<string, ListedModel[]>; resting?: Record<string, number>; probe?: (modelId: string) => ProbeResult }) {
    const db = new Map(options.rows.map((entry) => [`${entry.providerId}::${entry.modelId}`, entry]));
    const probed: string[] = [], typed: string[] = [], listedCalls: string[] = [], entered: { providerId: string; untilMs: number; kinds: readonly string[] }[] = [];
    const rests = new Map(Object.entries(options.resting ?? {}));
    const deps: DiscoveryDeps = {
        providers: options.providers,
        apiKey: () => "fixture-key",
        list: async (provider): Promise<ListingResult> => {
            listedCalls.push(provider.id);
            return { ok: true, models: options.listings?.[provider.id] ?? [] };
        },
        probe: async (target) => { probed.push(target.modelId); return options.probe ? options.probe(target.modelId) : chatResult("passed", { httpStatus: 200, detail: null }); },
        probeTyped: async (target) => { typed.push(target.modelId); return typedResult(); },
        typesEnabled: () => true,
        mediaEnabled: () => false,
        readRows: async () => ({ ok: true, rows: [...db.values()] }),
        saveRows: async (rows) => { for (const entry of rows) db.set(`${entry.row.providerId}::${entry.row.modelId}`, entry.row); },
        startRun: async () => ({ ok: true, runId: "run-1" }),
        finishRun: async () => {},
        recentSummaries: async () => [],
        notify: async () => true,
        persistObservations: async () => {},
        refreshSnapshot: async () => {},
        now: () => START,
        maxProbes: 10,
        runBudgetMs: 20 * 60_000,
        reviewLink: "https://owner.invalid/admin#models",
        rest: {
            load: async () => {},
            restingUntil: (providerId, nowMs) => (rests.get(providerId) ?? 0) > nowMs ? rests.get(providerId)! : null,
            enter: async (input) => {
                if ((rests.get(input.providerId) ?? 0) >= input.untilMs) return false;
                rests.set(input.providerId, input.untilMs);
                entered.push(input);
                return true;
            },
        },
    };
    return {
        db, probed, typed, listedCalls, entered,
        async run(): Promise<RunSummary> {
            const summary = await executeDiscovery("run-1", "cron", deps);
            assert.ok(summary);
            return summary;
        },
    };
}

await check("a resting provider is still listed, but none of its models is tested or marked missing", async () => {
    const until = START + 6 * 60 * 60_000;
    const h = harness({
        providers: [cf], resting: { cloudflare: until },
        rows: [row({ providerId: "cloudflare", modelId: "@cf/a" })],
        listings: { cloudflare: [listed("@cf/a"), listed("@cf/b")] },
    });
    const summary = await h.run();
    assert.deepEqual(h.listedCalls, ["cloudflare"]);
    assert.deepEqual(h.probed, []);
    assert.equal(summary.providers.cloudflare.restingUntil, iso(until));
    assert.equal(summary.providers.cloudflare.deferred, 2);
    assert.equal(h.db.get("cloudflare::@cf/b")?.probeStatus, "untested", "the new model waits");
    assert.equal(h.db.get("cloudflare::@cf/a")?.missingSince, null);
});

await check("a probe that hits the daily allowance starts one rest, leaves the row as it was and stops the provider's queue", async () => {
    const before = row({ providerId: "cloudflare", modelId: "@cf/a", probeAttempts: 2, probeStatus: "passed" });
    const h = harness({
        providers: [{ ...cf, discovery: { ...cf.discovery!, maxProbes: 5 } }],
        rows: [before, row({ providerId: "cloudflare", modelId: "@cf/c" }), row({ providerId: "cloudflare", modelId: "@cf/d", kind: "rerank", approvedAt: iso(START) } as Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">)],
        listings: { cloudflare: [listed("@cf/a"), listed("@cf/c")] },
        probe: () => chatResult("inconclusive", { httpStatus: 429, detail: QUOTA_BODY }),
    });
    const summary = await h.run();
    assert.equal(h.probed.length, 1, "the second model is not tried against a spent allowance");
    assert.equal(h.entered.length, 1);
    assert.equal(h.entered[0].untilMs, Date.parse("2026-11-26T00:00:00.000Z"));
    assert.deepEqual(h.entered[0].kinds, ["Chat", "rerank"]);
    const after = h.db.get(`cloudflare::${h.probed[0]}`)!;
    const original = h.probed[0] === "@cf/a" ? before : row({ providerId: "cloudflare", modelId: "@cf/c" });
    assert.equal(after.probeAttempts, original.probeAttempts, "a third inconclusive would have failed it");
    assert.equal(after.probedAt, original.probedAt);
    assert.equal(summary.providers.cloudflare.restingUntil, "2026-11-26T00:00:00.000Z");
    assert.equal(summary.providers.cloudflare.deferred, 2, "the model that hit the allowance was not tested either");
    assert.equal(summary.providers.cloudflare.probed, 0);
});

await check("Cloudflare tests at most its own cap a run, and kinds without a request shape are listed but never tested", async () => {
    const h = harness({
        providers: [cf],
        rows: [],
        listings: { cloudflare: [listed("@cf/a"), listed("@cf/b"), listed("@cf/c"), listed("@cf/baai/bge-m3", "embedding")] },
    });
    const summary = await h.run();
    assert.equal(h.probed.length, 1, "maxProbes 1 on the provider beats the global 10");
    assert.equal(summary.providers.cloudflare.deferred, 2);
    assert.deepEqual(h.typed, [], "embedding is untested on Cloudflare until C5");
    assert.equal(h.db.get("cloudflare::@cf/baai/bge-m3")?.kind, "embedding");
    assert.equal(h.db.get("cloudflare::@cf/baai/bge-m3")?.probeStatus, "untested");
});

await check("a seeded provider is never listed or marked missing, and retests on its own longer cadence", async () => {
    const h = harness({
        providers: [seedy],
        rows: [
            row({ providerId: "seedy", modelId: "new-seed", kind: "embedding", origin: "seed", probeStatus: "untested", probedAt: null, approvedAt: null, missedChecks: 0 } as Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">),
            row({ providerId: "seedy", modelId: "fresh", kind: "embedding", origin: "seed", probedAt: iso(START - 10 * DAY) } as Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">),
            row({ providerId: "seedy", modelId: "stale", kind: "embedding", origin: "seed", probedAt: iso(START - 31 * DAY) } as Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">),
        ],
    });
    const summary = await h.run();
    assert.deepEqual(h.listedCalls, [], "no list call");
    assert.deepEqual(h.typed.sort(), ["new-seed", "stale"], "10 days is inside the 30-day cadence");
    assert.equal(summary.providers.seedy.listing, "ok");
    for (const entry of h.db.values()) {
        assert.equal(entry.missedChecks, 0);
        assert.equal(entry.missingSince, null);
    }
});

console.log(`\n${passed} free provider checks passed`);
process.exit(0);
