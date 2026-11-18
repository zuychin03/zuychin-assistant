// Offline checks for the dashboard's profile view, the vault page builder and the approve route. No live services.
import assert from "node:assert/strict";
Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://profiles-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session",
});

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
let supabaseHandler: Handler = () => Response.json([]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "profiles-fixture.supabase.co") return supabaseHandler(url, init);
    throw new Error(`Unexpected request to ${url.hostname}`);
};

const { adminModelInfo, rowModel } = await import("../src/lib/ai/models/admin-view");
const { modelVaultPage, modelVaultPath } = await import("../src/lib/ai/models/vault");
const { catalogueRowToDb } = await import("../src/lib/ai/catalogue/rows");
const { PROVIDERS } = await import("../src/lib/ai/providers");
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;
type ProfileRecord = import("../src/lib/ai/models/profiles").ProfileRecord;
type ModelSpeed = import("../src/lib/ai/models/stats").ModelSpeed;

const NOW = "2026-11-19T04:00:00.000Z";
function row(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: `${overrides.modelId} (free)`, shortName: overrides.modelId.slice(overrides.modelId.lastIndexOf("/") + 1),
        description: "Listed.", developer: "Acme", free: true, metered: false, mayTrain: null, contextTokens: 128000, maxOutputTokens: 8192, inputs: ["text"],
        listedTools: true, listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: NOW, probeChatMs: 900,
        supportsTools: true, supportsSearch: true, supportsVision: false, supportsThinking: false, supportsStructured: null,
        firstSeenAt: NOW, lastSeenAt: NOW, missedChecks: 0, missingSince: null, notifiedMissingAt: null, approvedAt: null, ...overrides,
    };
}
function profile(providerId: string, modelId: string, overrides: Partial<ProfileRecord> = {}): ProfileRecord {
    return { providerId, modelId, tags: [], tagsSource: "seed", profile: null, approvedAt: null, draft: null, draftStatus: "none", draftError: null, draftedAt: null, lookupAttempts: 0, vaultPath: null, vaultSyncedAt: null, vaultError: null, ...overrides };
}
const speed = (overrides: Partial<ModelSpeed> = {}): ModelSpeed => ({ tier: "fast", firstAnswerMs: 1200, p90FirstAnswerMs: null, tokensPerSecond: 80, samples: 12, source: "calls", calls: 12, successRate: 1, reliable: true, ...overrides });

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

try {
    await check("the admin view blocks tags the route cannot carry and passes the stored profile through", () => {
        const stored = row({ providerId: "acme", modelId: "acme/plain", supportsTools: false });
        const info = adminModelInfo(stored, rowModel(stored, undefined), profile("acme", "acme/plain", { draftStatus: "failed", draftError: "No source answered.", lookupAttempts: 2 }), undefined, undefined);
        assert.deepEqual(Object.keys(info.blockedTags).sort(), ["agentic", "research", "vision"]);
        assert.equal(info.profile?.draftStatus, "failed");
        assert.equal(info.profile?.lookupAttempts, 2);
        assert.equal(info.speed.source, "test", "the probe time stands in until calls are recorded");
        assert.equal(info.tagsSource, "derived");
        assert.equal(info.feedback, null);
        assert.ok(info.measured.includes("Tool calls failed in testing"));
    });

    await check("approved tags win over derived ones, and code models keep their audited capabilities", () => {
        const nim = PROVIDERS.find((entry) => entry.id === "nvidia-nim")!;
        const code = nim.chatModels.find((model) => model.id === "nvidia/nemotron-3-ultra-550b-a55b")!;
        const stored = row({ providerId: "nvidia-nim", modelId: code.id, origin: "seed", supportsTools: null });
        const info = adminModelInfo(stored, rowModel(stored, code), profile("nvidia-nim", code.id, { tags: ["coding", "long-context"], tagsSource: "owner" }), undefined, { all: { useful: 3, notUseful: 1 } });
        assert.deepEqual(info.tags, ["coding", "long-context"]);
        assert.equal(info.tagsSource, "owner");
        assert.ok(!("agentic" in info.blockedTags), "the code model's audited tool support counts, not the empty test column");
        assert.deepEqual(info.feedback, { useful: 3, notUseful: 1 });
    });

    await check("the vault page joins every approved route of one model and skips drafts", () => {
        const approvedProfile = { description: "A small coding model.", developer: "Cohere", params: "30B total, 3B active", strengths: ["Terminal tasks"], weaknesses: ["Short answers"], sources: [{ title: "Card | site", url: "https://example.org/card" }] };
        const routes = [
            { providerLabel: "OpenRouter", row: row({ providerId: "openrouter", modelId: "cohere/north-mini-code:free" }), record: profile("openrouter", "cohere/north-mini-code:free", { profile: approvedProfile, approvedAt: "2026-11-19T01:00:00.000Z" }), tags: ["coding" as const, "agentic" as const], speed: speed(), measured: [] },
            { providerLabel: "Kilo", row: row({ providerId: "kilo", modelId: "cohere/north-mini-code:free" }), record: profile("kilo", "cohere/north-mini-code:free", { profile: approvedProfile, approvedAt: "2026-11-18T01:00:00.000Z" }), tags: ["coding" as const], speed: speed({ tier: "slow", firstAnswerMs: 30_000, source: "test" }), measured: ["Forced tool calls (explicit Search) do not work on this route"] },
            { providerLabel: "NIM", row: row({ providerId: "nvidia-nim", modelId: "cohere/north-mini-code" }), record: profile("nvidia-nim", "cohere/north-mini-code", { draftStatus: "ready" }), tags: [], speed: speed(), measured: [] },
        ];
        const page = modelVaultPage(routes, new Date(NOW));
        assert.ok(page);
        assert.match(page.markdown, /^# cohere\/north-mini-code:free\n/);
        assert.match(page.markdown, /\| OpenRouter \| `cohere\/north-mini-code:free` \| Free \| Fast, median first answer 1\.2 s over 12 calls \| Nothing flagged \|/);
        assert.match(page.markdown, /\| Kilo \| .* \| Slow, 30 s in its last test \| Forced tool calls/);
        assert.ok(!page.markdown.includes("NIM"), "a route without an approved profile is left out");
        assert.match(page.markdown, /- \[Card \| site\]\(https:\/\/example\.org\/card\)/);
        assert.match(page.markdown, /## Good for\n\n- Coding: .*\n- Agentic: /);
        assert.ok(!page.markdown.includes("—"), "no em dashes");
        assert.match(page.summary, /model profile: A small coding model\./);
        assert.equal(modelVaultPage([routes[2]]), null);
        assert.equal(modelVaultPath("cohere/north-mini-code:free"), "wiki/entities/model-north-mini-code.md");
        assert.equal(modelVaultPath("nvidia/Nemotron 3 Ultra"), "wiki/entities/model-nemotron-3-ultra.md");
    });

    await check("the info modal shows tags, speed, weaknesses, measured facts and sources from an approved profile", async () => {
        const { createElement } = await import("react");
        const { renderToStaticMarkup } = await import("react-dom/server");
        const { createRequire } = await import("node:module");
        // CSS modules resolve to their class names, as in the other component tests.
        createRequire(import.meta.url).extensions[".css"] = (module) => { module.exports = new Proxy({}, { get: (_target, key) => key === "__esModule" ? false : String(key) }); };
        const { ModelInfoModal } = await import("../src/app/home/controls");
        const model = {
            id: "cohere/north-mini-code:free", label: "North Mini Code (free)", supportsTools: true, tags: ["coding", "agentic", "unknown-tag"],
            speed: { tier: "fast" as const, firstAnswerMs: 1200, tokensPerSecond: 85, samples: 23, source: "calls" as const, calls: 24, successRate: 0.96 },
            meta: {
                developer: "Cohere", description: "A small coding model.", inputs: ["Text"], strengths: ["Terminal tasks"], weaknesses: ["Short answers"],
                measured: ["Forced tool calls (explicit Search) do not work on this route"], sources: [{ title: "Model card", url: "https://example.org/card" }],
                origin: "profile" as const, profileApprovedAt: NOW,
            },
        };
        const html = renderToStaticMarkup(createElement(ModelInfoModal, { model, providerLabel: "OpenRouter", onClose: () => {} }));
        const order = ["Good for", "Speed", "Inputs", "Capabilities", "Excels at", "Weak at", "Measured", "Sources"].map((label) => html.indexOf(`>${label}<`));
        assert.ok(order.every((index) => index > 0), `every section renders: ${order.join(",")}`);
        assert.deepEqual([...order].sort((a, b) => a - b), order, "sections keep the planned order");
        assert.match(html, />Coding</);
        assert.ok(!html.includes("unknown-tag"));
        assert.match(html, /first answer 1\.2 s \(median of 23 calls\), 85 tokens\/s, 96% succeeded\. Measured over the last 14 days\./);
        assert.match(html, /<li>Terminal tasks<\/li>/, "profile strengths read as a list, not colour chips");
        assert.match(html, /href="https:\/\/example\.org\/card" target="_blank" rel="noopener noreferrer"/);
        const plain = renderToStaticMarkup(createElement(ModelInfoModal, { model: { id: "x", label: "X", meta: null }, providerLabel: "P", onClose: () => {} }));
        assert.match(plain, /No details available for this model yet\./);
        assert.ok(!plain.includes(">Speed<") && !plain.includes(">Good for<"));
    });

    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../src/proxy");
    const route = await import("../src/app/api/admin/models/profile/route");
    const { createSessionValue } = await import("../src/lib/auth/session");
    const { AUTH_COOKIE } = await import("../src/lib/auth/config");
    const URL_PROFILE = "https://fixture.invalid/api/admin/models/profile";
    const cookie = `${AUTH_COOKIE}=${await createSessionValue()}`;
    const post = (body: unknown) => route.POST(new NextRequest(URL_PROFILE, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

    const stored = row({ providerId: "openrouter", modelId: "cohere/north-mini-code:free" });
    const draft = { description: "Draft.", strengths: [], weaknesses: [], sources: [{ title: "Fetched", url: "https://example.org/fetched" }], suggestedTags: ["coding"], tagReasons: {}, basis: "lookup", siblingOf: null, sourcesTried: [] };
    let rpcBodies: Record<string, unknown>[] = [];
    function serve(options: { profileRow?: Record<string, unknown> | null; profileError?: boolean } = {}) {
        rpcBodies = [];
        supabaseHandler = async (url, init) => {
            if (url.pathname.endsWith("/model_catalogue")) return Response.json([catalogueRowToDb(stored, NOW)]);
            if (url.pathname.endsWith("/model_profiles")) {
                if (options.profileError) return Response.json({ code: "42P01", message: "relation does not exist" }, { status: 404 });
                return options.profileRow ? Response.json(options.profileRow) : new Response(null, { status: 406, headers: { "content-type": "application/json" } });
            }
            if (url.pathname.endsWith("/rpc/model_profile_approve")) {
                rpcBodies.push(JSON.parse(String(init?.body ?? "{}")));
                return Response.json("ok");
            }
            return Response.json([]);
        };
    }

    await check("the approve route needs a session", async () => {
        assert.equal((await proxy(new NextRequest(URL_PROFILE, { method: "POST" }))).status, 307);
        assert.equal((await route.POST(new NextRequest(URL_PROFILE, { method: "POST" }))).status, 401);
    });

    await check("the approve route refuses unknown tags, tags the model cannot carry, and approval without a tag", async () => {
        serve({ profileRow: { provider_id: stored.providerId, model_id: stored.modelId, tags: [], tags_source: "seed", draft, draft_status: "ready" } });
        const ref = { providerId: stored.providerId, modelId: stored.modelId };
        assert.equal((await post({ ...ref, tags: ["hacking"] })).status, 400);
        const blocked = await post({ ...ref, tags: ["vision"] });
        assert.equal(blocked.status, 400);
        assert.match((await blocked.json()).error, /Vision: needs image input/);
        const untagged = await post({ ...ref, approveModel: true });
        assert.equal(untagged.status, 400);
        assert.match((await untagged.json()).error, /at least one purpose tag/);
        assert.equal((await post({ ...ref })).status, 400);
        assert.equal(rpcBodies.length, 0);
    });

    await check("one-click Approve sends the model, tags and edited profile together, keeping only fetched sources", async () => {
        serve({ profileRow: { provider_id: stored.providerId, model_id: stored.modelId, tags: [], tags_source: "seed", draft, draft_status: "ready" } });
        const response = await post({
            providerId: stored.providerId, modelId: stored.modelId, tags: ["agentic", "coding"], approveModel: true,
            profile: { description: "Edited by hand.", strengths: ["Terminal tasks"], weaknesses: [], sources: [{ title: "Fetched", url: "https://example.org/fetched" }, { title: "Added", url: "https://example.org/added" }] },
        });
        assert.equal(response.status, 200);
        assert.equal(rpcBodies.length, 1);
        const body = rpcBodies[0] as { p_tags: string[]; p_profile: { description: string; sources: { url: string }[] }; p_approve_model: boolean };
        assert.deepEqual(body.p_tags, ["coding", "agentic"]);
        assert.equal(body.p_approve_model, true);
        assert.equal(body.p_profile.description, "Edited by hand.");
        assert.deepEqual(body.p_profile.sources.map((source) => source.url), ["https://example.org/fetched"]);
    });

    await check("Save tags sends tags only and a missing profile table is a clear 503", async () => {
        serve({ profileRow: { provider_id: stored.providerId, model_id: stored.modelId, tags: ["coding"], tags_source: "owner" } });
        assert.equal((await post({ providerId: stored.providerId, modelId: stored.modelId, tags: ["coding"] })).status, 200);
        assert.equal(rpcBodies[0].p_profile, null);
        assert.equal(rpcBodies[0].p_approve_model, false);
        serve({ profileError: true });
        const missing = await post({ providerId: stored.providerId, modelId: stored.modelId, tags: ["coding"] });
        assert.equal(missing.status, 503);
        assert.match((await missing.json()).error, /v7-model-awareness\.sql/);
    });
} finally {
    globalThis.fetch = realFetch;
}

console.log(`${checks} model profile checks passed`);
