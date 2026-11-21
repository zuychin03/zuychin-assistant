// Offline checks for model_status and /model by purpose: the digest, the purpose picks, and both through their real entry points.
import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://status-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "status-test-key", GEMINI_FREE_API_KEY: "status-test-key", KNOWLEDGE_EMBEDDING_MODEL: "",
});

let prefs: Record<string, unknown> = {};
let runs: unknown[] = [];
const unexpected: string[] = [];
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (url.hostname === "status-fixture.supabase.co" && method === "GET") {
        const table = url.pathname.replace("/rest/v1/", "");
        if (table === "user_profiles") return Response.json({ id: "profile", system_prompt: "Fixture", preferences: prefs });
        if (table === "cron_state") return Response.json({ value: { model: "nvidia/nemotron-3-embed-1b" } });
        if (table === "model_discovery_runs") return Response.json(runs);
    }
    unexpected.push(`${method} ${url.origin}${url.pathname}`);
    throw new Error(`Unexpected fixture request: ${method} ${url.href}`);
};

const { PROVIDERS, isProviderAvailable, providers } = await import("../src/lib/ai/providers");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { setStatsSnapshotForTests } = await import("../src/lib/ai/models/stats");
const { buildRoster } = await import("../src/lib/ai/models/roster");
const { formatModelStatus } = await import("../src/lib/ai/models/status");
const { formatModelListing, formatPurposePicks } = await import("../src/lib/ai/models/command");
const { ragChat } = await import("../src/lib/ai/rag-service");
const { executeTool } = await import("../src/lib/ai/mcp-service");
const { CODE_SEED_ROWS } = await import("./fixtures/catalogue-seeds.mts");
type RosterEntry = import("../src/lib/ai/models/roster").RosterEntry;
type SpeedStats = import("../src/lib/ai/models/stats").SpeedStats;
type ProfileRecord = import("../src/lib/ai/models/profiles").ProfileRecord;

for (const provider of PROVIDERS) process.env[provider.apiKeyEnv] = "status-test-key";
process.env.OPENCODE_API_KEY = "";

const LAGUNA = "nvidia-nim::poolside/laguna-xs-2.1";
const GLM = "nvidia-nim::z-ai/glm-5.3-flash";
const FREE_FLASH = "gemini-free::gemini-3.8-flash";
const PAID_FLASH = "gemini::gemini-3.8-flash";

function speed(key: string, ms: number, succeeded = 10, failed = 0): SpeedStats {
    const [providerId, modelId] = key.split("::");
    return { providerId, modelId, timedCalls: 10, medianFirstAnswerMs: ms, p90FirstAnswerMs: ms * 2, medianDurationMs: ms * 3, medianTokensPerSecond: 50, succeeded, failed, lastSuccessAt: "2026-11-19T00:00:00.000Z" };
}
function profile(key: string, tags: ProfileRecord["tags"], draftStatus: ProfileRecord["draftStatus"] = "none"): ProfileRecord {
    const [providerId, modelId] = key.split("::");
    return { providerId, modelId, tags, tagsSource: "owner", profile: null, approvedAt: null, draft: null, draftStatus, draftError: null, draftedAt: null, lookupAttempts: 0, vaultPath: null, vaultSyncedAt: null, vaultError: null, removedAt: null };
}
const PROFILES = [profile(LAGUNA, ["coding", "agentic"]), profile(GLM, ["coding", "research"], "ready"), profile(PAID_FLASH, ["coding", "reasoning"])];
const LAGUNA_ROW = CODE_SEED_ROWS.find((row) => row.providerId === "nvidia-nim" && row.modelId === "poolside/laguna-xs-2.1")!;
const SPEEDS = [speed(LAGUNA, 1500), speed(GLM, 30_000, 3, 7), speed(FREE_FLASH, 9000)];
const roster = (freeOnly = false, extra: SpeedStats[] = []) => buildRoster({
    providers: providers(), rows: [LAGUNA_ROW], profiles: PROFILES,
    speed: new Map([...SPEEDS, ...extra].map((entry) => [`${entry.providerId}::${entry.modelId}`, entry])),
    feedback: new Map(), available: isProviderAvailable,
}, { freeOnly, paidOrchestrator: true, unattended: false });

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    prefs = {}; runs = []; unexpected.length = 0;
    setCatalogueSnapshotForTests([LAGUNA_ROW], "ok", PROFILES);
    setStatsSnapshotForTests(SPEEDS);
    await run();
    assert.deepEqual(unexpected, [], "no request outside the fixture");
    checks++;
    console.log(`PASS ${name}`);
}

const DONE_RUN = { startedAt: "2026-11-18T19:00:00.000Z", trigger: "cron", status: "done", summary: { added: ["a", "b"], passed: ["a"], newlyMissing: [], drafted: ["a"] } };

try {
    await check("the problems view lists failing, missing, unreliable and slow models, and skips test and lookup runs for the last check", () => {
        const entries = roster().map((entry) => entry.key === LAGUNA ? { ...entry, status: "failing" as const } : entry.key === FREE_FLASH ? { ...entry, status: "missing" as const } : entry);
        const text = formatModelStatus({
            roster: entries, profiles: PROFILES, show: "problems", purpose: null,
            runs: [{ startedAt: "2026-11-19T01:00:00.000Z", trigger: "manual", status: "done", summary: { kind: "lookup" } }, { startedAt: "2026-11-19T00:30:00.000Z", trigger: "manual", status: "done", summary: { kind: "test" } }, DONE_RUN],
        });
        assert.match(text, /^Last model check 19\/11\/2026, 6:00 am Melbourne time \(daily\): 2 added, 1 passed, 0 newly missing, 1 profiles drafted\./);
        assert.match(text, new RegExp(`Failed their last test \\(1\\): ${LAGUNA}\\.`));
        assert.match(text, new RegExp(`Missing from the provider list \\(1\\): ${FREE_FLASH}\\.`));
        assert.match(text, new RegExp(`Under 80% of calls succeeded in 14 days \\(1\\): ${GLM} 30%\\.`));
        assert.match(text, new RegExp(`Slow first answer, over 20 s \\(1\\): ${GLM} 30`));
        assert.match(text, new RegExp(`Profile drafts waiting for review on the dashboard \\(1\\): ${GLM}\\.`), "a waiting draft is always mentioned");
        assert.ok(!text.includes("chat models on available providers"), "speed counts only in the all view");
    });

    await check("the all view adds speed counts, drafts lists only drafts, and a purpose adds free picks", () => {
        const entries = roster();
        const all = formatModelStatus({ roster: entries, runs: [], profiles: [], show: "all", purpose: null });
        assert.match(all, /^No model check has run yet\./);
        assert.match(all, /chat models on available providers: \d+ fast, \d+ medium, 1 slow, \d+ not measured yet\./);
        assert.match(all, /Under 80% of calls/);

        const drafts = formatModelStatus({ roster: entries, runs: [DONE_RUN], profiles: [], show: "drafts", purpose: null });
        assert.ok(!/Slow first answer|No failing/.test(drafts), "the drafts view leaves out problems");
        assert.match(drafts, /No profile drafts are waiting for review\./);

        const coding = formatModelStatus({ roster: entries, runs: [], profiles: [], show: "problems", purpose: "coding" });
        const picks = /Best free picks for coding: (.+)\./.exec(coding)?.[1] ?? "";
        assert.ok(picks.startsWith(`${LAGUNA} (fast, 1.5 s)`), picks);
        assert.ok(!picks.includes(PAID_FLASH), "paid models are never automatic picks");
        assert.match(formatModelStatus({ roster: entries, runs: [], profiles: [], show: "problems", purpose: "vision" }), /Best free picks for vision|No free model is approved for vision/);
    });

    await check("a failed or running check says so with its reason", () => {
        const failed = formatModelStatus({ roster: [], runs: [{ ...DONE_RUN, status: "failed", summary: { error: "Supabase timed out" } }], profiles: [], show: "problems", purpose: null });
        assert.match(failed, /^The last model check, .+ \(daily\), failed: Supabase timed out\./);
        assert.match(failed, /No failing, missing, unreliable or slow models right now\./);
        assert.match(formatModelStatus({ roster: [], runs: [{ ...DONE_RUN, status: "running" }], profiles: [], show: "problems", purpose: null }), /is still running\./);
    });

    await check("/model <purpose> ranks tagged usable models, paid ones only when free only is off", () => {
        const fastPaid = [speed(PAID_FLASH, 2000)];
        const entries: readonly RosterEntry[] = roster(false, fastPaid);
        const picks = formatPurposePicks(entries, "coding", false);
        const lines = picks.split("\n");
        assert.match(lines[0], /^Best models for coding \(/);
        assert.match(lines[1], /^1\. .+, free, fast 1\.5 s\. Switch: \/model nvidia-nim \S+$/, "a tie goes to the free model");
        assert.match(lines[2], /^2\. .+, paid, fast 2\.0 s\. Switch: \/model gemini \S+$/, "a fast paid model is offered when free only is off");
        assert.equal(lines.length, 6, "five picks at most");
        assert.ok(!picks.includes(GLM.split("::")[1]), "the slow, unreliable model is ranked out");
        const free = formatPurposePicks(roster(true, fastPaid), "coding", true);
        assert.match(free.split("\n")[0], /, free only:$/);
        assert.ok(!free.includes(", paid, "));
        assert.match(formatPurposePicks(roster(), "multilingual", false).split("\n")[0], /^(No model is tagged for multilingual right now\.|Best models for multilingual)/);
    });

    await check("the /model listing shows speed and the first three purposes next to each model", () => {
        const text = formatModelListing([{ provider: "NVIDIA NIM", providerId: "nvidia-nim", models: [
            { id: "poolside/laguna-xs-2.1", name: "laguna", label: "Laguna", status: "new" },
            { id: "z-ai/glm-5.3-flash", name: "glm", label: "GLM" },
            { id: "unknown/model", name: "plain", label: "Plain" },
        ] }], roster());
        assert.match(text, /• laguna - Laguna \(new; fast 1\.5 s; good for coding, agentic\)/);
        assert.match(text, /• glm - GLM \(slow 30 s; good for research, coding\)/, "tags follow the fixed purpose order");
        assert.match(text, /• plain - Plain$/m);
    });

    await check("Telegram /model coding answers with picks and saves nothing; one provider word still asks for a model", async () => {
        const picks = await ragChat({ message: "/model coding", channel: "telegram" });
        assert.match(picks.reply, /^Best models for coding/);
        assert.ok(picks.reply.includes("Switch: /model"));
        const listing = await ragChat({ message: "/model list", channel: "telegram" });
        assert.match(listing.reply, /or \/model <purpose> for the best picks \(research, coding/);
        assert.match(listing.reply, /good for coding, agentic/);
        const one = await ragChat({ message: "/model nvidia-nim", channel: "telegram" });
        assert.match(one.reply, /^Please specify both a provider and a model\./, "a single provider word is not a purpose");
    });

    await check("Free only narrows the Telegram picks to free models", async () => {
        prefs = { freeOnly: true };
        const picks = await ragChat({ message: "/model coding", channel: "telegram" });
        assert.match(picks.reply.split("\n")[0], /free only:$/);
        assert.ok(!picks.reply.includes(", paid, "));
    });

    await check("the model_status chat tool reads the run log and answers without calling a model", async () => {
        runs = [{ id: "run-1", trigger: "cron", started_at: DONE_RUN.startedAt, finished_at: DONE_RUN.startedAt, status: "done", summary: DONE_RUN.summary }];
        const text = await executeTool("model_status", { show: "all", purpose: "coding" }, undefined, { freeOnly: true });
        assert.match(text, /^Last model check 19\/11\/2026/);
        assert.match(text, /chat models on available providers/);
        assert.match(text, new RegExp(`Best free picks for coding: ${LAGUNA}`));
        assert.match(await executeTool("model_status", { purpose: "poetry" }), /^Unknown purpose "poetry"/);
        runs = [];
        assert.match(await executeTool("model_status", { show: "drafts" }), new RegExp(`waiting for review on the dashboard \\(1\\): ${GLM}`));
    });
} finally {
    setCatalogueSnapshotForTests([]);
    setStatsSnapshotForTests([]);
}

console.log(`${checks} model status checks passed`);
