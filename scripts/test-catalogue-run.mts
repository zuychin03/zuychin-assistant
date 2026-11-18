// Offline checks for the daily model discovery run, its store lock and its routes. No live services.
import assert from "node:assert/strict";
Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://catalogue-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session", CRON_SECRET: "fixture-cron",
});

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
let supabaseHandler: Handler = () => Response.json([]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "catalogue-fixture.supabase.co") return supabaseHandler(url, init);
    if (url.hostname === "discord.com") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request to ${url.hostname}`);
};

const { applyProbe, discoveryMessage, executeDiscovery, executeModelTest, maxProbesFromEnv } = await import("../src/lib/ai/catalogue/run");
const { PROVIDERS, retiredChatModelIds } = await import("../src/lib/ai/providers");
const { saveCatalogueRows, startDiscoveryRun } = await import("../src/lib/ai/catalogue/store");
type DiscoveryDeps = import("../src/lib/ai/catalogue/run").DiscoveryDeps;
type RunSummary = import("../src/lib/ai/catalogue/run").RunSummary;
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;
type ProviderConfig = import("../src/lib/ai/providers").ProviderConfig;
type ListedModel = import("../src/lib/ai/catalogue/sources").ListedModel;
type ListingResult = import("../src/lib/ai/catalogue/sources").ListingResult;
type ProbeResult = import("../src/lib/ai/catalogue/probe").ProbeResult;
type ProbeTarget = import("../src/lib/ai/catalogue/probe").ProbeTarget;
type SavedRow = import("../src/lib/ai/catalogue/store").SavedRow;

const DAY = 24 * 60 * 60_000;
const START = Date.parse("2026-11-20T04:10:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const acme: ProviderConfig = {
    id: "acme", label: "Acme", kind: "openai-compatible", baseUrl: "https://acme.invalid/v1", apiKeyEnv: "ACME_FIXTURE_KEY",
    discovery: { source: "openai-list", include: "all", pricing: "listed" },
    chatModels: [{ id: "acme/pinned", label: "Pinned", name: "pinned", free: true, supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: true }],
    embeddingModels: [],
};

function listed(modelId: string, free = true): ListedModel {
    return {
        modelId, label: `Label ${modelId}`, description: null, developer: null, free, contextTokens: 128000, maxOutputTokens: 8192,
        inputs: ["text"], listedTools: true, listedStructured: null, listedThinking: null, mayTrain: null, chat: true,
    };
}

function row(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.slice(overrides.modelId.lastIndexOf("/") + 1),
        description: null, developer: null, free: true, metered: false, mayTrain: null,
        contextTokens: 128000, maxOutputTokens: 8192, inputs: ["text"], listedTools: true, listedStructured: null, listedThinking: null,
        probeStatus: "passed", probeAttempts: 0, probedAt: iso(START - DAY), probeChatMs: 900,
        supportsTools: true, supportsSearch: true, supportsVision: false, supportsThinking: null, supportsStructured: null,
        firstSeenAt: iso(START - 30 * DAY), lastSeenAt: iso(START - DAY), missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: null,
        ...overrides,
    };
}

function probeResult(status: ProbeResult["status"], extra: Partial<ProbeResult> = {}): ProbeResult {
    const outcome = status === "passed" ? "pass" : status === "failed" ? "fail" : "transient";
    const step = { outcome, httpStatus: status === "passed" ? 200 : null, ms: 50, detail: null } as const;
    return {
        status, retired: false, chatMs: status === "passed" ? 1200 : null,
        supportsTools: status === "passed" ? true : null, supportsSearch: status === "passed" ? true : null, supportsVision: null,
        steps: { chat: step, tools: step, forced: step, vision: { ...step, outcome: "skipped" } }, ...extra,
    };
}

interface Harness {
    deps: DiscoveryDeps;
    db: Map<string, CatalogueRow>;
    saved: SavedRow[][];
    notifications: string[];
    probed: string[];
    finished: { runId: string; status: string; summary: Record<string, unknown> }[];
    run(): Promise<RunSummary>;
}

function harness(options: {
    rows?: CatalogueRow[];
    listings?: Record<string, ListingResult | (() => ListingResult)>;
    probe?: (target: ProbeTarget) => ProbeResult | Promise<ProbeResult>;
    summaries?: Record<string, unknown>[];
    notifyOk?: boolean;
    maxProbes?: number;
    runBudgetMs?: number;
    providers?: ProviderConfig[];
    tick?: number;
    now?: number;
    removed?: string[];
}): Harness {
    const db = new Map((options.rows ?? []).map((entry) => [`${entry.providerId}::${entry.modelId}`, entry]));
    const saved: SavedRow[][] = [], notifications: string[] = [], probed: string[] = [];
    const finished: Harness["finished"] = [];
    const summaries = [...(options.summaries ?? [])];
    let clock = options.now ?? START;
    const deps: DiscoveryDeps = {
        providers: options.providers ?? [acme],
        apiKey: () => "fixture-key",
        list: async (provider) => {
            const listing = options.listings?.[provider.id];
            if (!listing) return { ok: false, status: 503, error: "no fixture" };
            return typeof listing === "function" ? listing() : listing;
        },
        probe: async (target) => {
            probed.push(`${target.provider.id}::${target.modelId}`);
            return options.probe ? options.probe(target) : probeResult("passed");
        },
        readRows: async () => ({ ok: true, rows: [...db.values()] }),
        saveRows: async (rows) => {
            saved.push([...rows]);
            for (const entry of rows) db.set(`${entry.row.providerId}::${entry.row.modelId}`, entry.row);
        },
        startRun: async () => ({ ok: true, runId: "run-1" }),
        finishRun: async (runId, status, summary) => {
            finished.push({ runId, status, summary: summary as Record<string, unknown> });
            summaries.unshift(summary as Record<string, unknown>);
        },
        recentSummaries: async () => summaries,
        notify: async (text) => { notifications.push(text); return options.notifyOk ?? true; },
        persistObservations: async () => {},
        refreshSnapshot: async () => {},
        now: () => { const value = clock; clock += options.tick ?? 0; return value; },
        maxProbes: options.maxProbes ?? 10,
        runBudgetMs: options.runBudgetMs ?? 20 * 60_000,
        reviewLink: "https://owner.invalid/admin#models",
        removedKeys: () => new Set(options.removed ?? []),
    };
    return {
        deps, db, saved, notifications, probed, finished,
        async run() {
            const summary = await executeDiscovery("run-1", "cron", deps);
            assert.ok(summary, "the run should finish");
            return summary;
        },
    };
}

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const pinned = () => row({ providerId: "acme", modelId: "acme/pinned", origin: "seed", shortName: "pinned", approvedAt: iso(START - 30 * DAY) });
const okListing = (...ids: string[]): ListingResult => ({ ok: true, models: ids.map((id) => listed(id)) });

try {
    await check("a failed listing changes no rows and counts toward a failure streak", async () => {
        const h = harness({ rows: [pinned()], listings: { acme: { ok: false, status: 503, error: "down" } } });
        const summary = await h.run();
        assert.equal(h.saved.length, 0);
        assert.deepEqual(h.probed, []);
        assert.equal(summary.providers.acme.listing, "failed");
        assert.equal(summary.providers.acme.listingFailures, 1);
        assert.equal(h.db.get("acme::acme/pinned")!.missedChecks, 0);
        assert.equal(h.notifications.length, 0);
    });

    await check("an empty listing counts as failed, so nothing is marked missing", async () => {
        const h = harness({ rows: [pinned()], listings: { acme: { ok: true, models: [] } } });
        const summary = await h.run();
        assert.equal(summary.providers.acme.listing, "failed");
        assert.equal(h.saved.length, 0);
    });

    await check("the second failed listing in a row sends one message, the third does not", async () => {
        const failing: ListingResult = { ok: false, status: 503, error: "down" };
        const h = harness({ rows: [pinned()], listings: { acme: failing }, summaries: [{ kind: "run", providers: { acme: { listing: "failed", listingFailures: 1 } } }] });
        const second = await h.run();
        assert.equal(second.providers.acme.listingFailures, 2);
        assert.equal(h.notifications.length, 1);
        assert.match(h.notifications[0], /Provider list failed twice in a row \(1\):\n- Acme \(HTTP 503\)/);
        const third = await h.run();
        assert.equal(third.providers.acme.listingFailures, 3);
        assert.equal(h.notifications.length, 1);
    });

    await check("one miss counts, the second sets missing_since, and the picker model gets one message", async () => {
        const h = harness({ rows: [pinned(), row({ providerId: "acme", modelId: "acme/other" })], listings: { acme: okListing("acme/other") } });
        const first = await h.run();
        assert.equal(h.db.get("acme::acme/pinned")!.missedChecks, 1);
        assert.equal(h.db.get("acme::acme/pinned")!.missingSince, null);
        assert.equal(first.newlyMissing.length, 0);
        assert.equal(h.notifications.length, 0);

        const second = await h.run();
        const missing = h.db.get("acme::acme/pinned")!;
        assert.equal(missing.missedChecks, 2);
        assert.equal(missing.missingSince, iso(START));
        assert.equal(missing.notifiedMissingAt, iso(START));
        assert.deepEqual(second.newlyMissing, ["acme::acme/pinned"]);
        assert.equal(h.notifications.length, 1);
        assert.match(h.notifications[0], /Missing from the provider's list, still selectable \(1\):\n- Acme: acme\/pinned \(`pinned`\)/);
        assert.match(h.notifications[0], /Review: https:\/\/owner\.invalid\/admin#models/);

        await h.run();
        assert.equal(h.notifications.length, 1, "a model already reported missing is not reported again");
    });

    await check("a model outside the picker goes missing without a message", async () => {
        const unapproved = row({ providerId: "acme", modelId: "acme/untested", probeStatus: "untested", probedAt: null, missedChecks: 1, free: false });
        const h = harness({ rows: [pinned(), unapproved], listings: { acme: okListing("acme/pinned") } });
        await h.run();
        assert.equal(h.db.get("acme::acme/untested")!.missingSince, iso(START));
        assert.equal(h.notifications.length, 0);
    });

    await check("a missing model listed again is cleared, ready to be reported if it goes again", async () => {
        const gone = row({ providerId: "acme", modelId: "acme/pinned", origin: "seed", shortName: "pinned", approvedAt: iso(START - 30 * DAY),
            missedChecks: 3, missingSince: iso(START - 2 * DAY), notifiedMissingAt: iso(START - 2 * DAY) });
        const h = harness({ rows: [gone], listings: { acme: okListing("acme/pinned") } });
        await h.run();
        const back = h.db.get("acme::acme/pinned")!;
        assert.equal(back.missedChecks, 0);
        assert.equal(back.missingSince, null);
        assert.equal(back.notifiedMissingAt, null);
        assert.equal(back.lastSeenAt, iso(START));
    });

    await check("new free models are added and probed; new paid models are added untested and never probed", async () => {
        const h = harness({ rows: [pinned()], listings: { acme: { ok: true, models: [listed("acme/pinned"), listed("acme/fresh-open"), listed("acme/fresh-paid", false)] } } });
        const summary = await h.run();
        assert.deepEqual(h.probed, ["acme::acme/fresh-open"]);
        const free = h.db.get("acme::acme/fresh-open")!;
        assert.equal(free.origin, "discovered");
        assert.equal(free.probeStatus, "passed");
        assert.equal(free.approvedAt, null);
        assert.equal(free.shortName, "fresh-open");
        assert.equal(free.firstSeenAt, iso(START));
        assert.equal(free.metered, false);
        const paid = h.db.get("acme::acme/fresh-paid")!;
        assert.equal(paid.probeStatus, "untested");
        assert.equal(paid.free, false);
        assert.equal(paid.metered, true);
        assert.deepEqual(summary.added.sort(), ["acme::acme/fresh-open", "acme::acme/fresh-paid"]);
        assert.deepEqual(summary.passed, ["acme::acme/fresh-open"]);
        assert.equal(h.notifications.length, 1);
        assert.match(h.notifications[0], /New models passed their tests, not yet approved for automatic routes \(1\):\n- Acme: Label acme\/fresh-open \(`fresh-open`\)/);
        const detail = h.saved[0].find((entry) => entry.row.modelId === "acme/fresh-open")!.probeDetail as { steps: unknown };
        assert.ok(detail.steps, "probe detail is saved with the probed row");
        assert.equal(h.saved[0].find((entry) => entry.row.modelId === "acme/fresh-paid")!.probeDetail, undefined);
    });

    await check("an untested free seed row with no code entry is probed like a new model; a paid one is not", async () => {
        const seeded = row({ providerId: "acme", modelId: "acme/seeded", origin: "seed", shortName: "seeded", probeStatus: "untested", probedAt: null, approvedAt: null });
        const seededPaid = row({ providerId: "acme", modelId: "acme/seeded-paid", origin: "seed", shortName: "seeded-paid", free: false, metered: true, probeStatus: "untested", probedAt: null, approvedAt: null });
        const listing = okListing("acme/pinned", "acme/seeded");
        if (listing.ok) listing.models.push(listed("acme/seeded-paid", false));
        const h = harness({ rows: [pinned(), seeded, seededPaid], listings: { acme: listing } });
        const summary = await h.run();
        assert.ok(h.probed.includes("acme::acme/seeded"));
        assert.ok(!h.probed.includes("acme::acme/seeded-paid"));
        assert.equal(h.db.get("acme::acme/seeded")!.probeStatus, "passed");
        assert.equal(h.db.get("acme::acme/seeded")!.approvedAt, null);
        assert.deepEqual(summary.added, []);
    });

    await check("a new model whose short name is taken gets a numbered one", async () => {
        const h = harness({ rows: [pinned()], listings: { acme: okListing("acme/pinned", "other/pinned") } });
        await h.run();
        assert.equal(h.db.get("acme::other/pinned")!.shortName, "pinned-2");
    });

    await check("the probe cap holds and the rest wait for the next run", async () => {
        const ids = ["acme/a", "acme/b", "acme/c", "acme/d"];
        const h = harness({ rows: [pinned()], listings: { acme: okListing("acme/pinned", ...ids) }, maxProbes: 2 });
        const first = await h.run();
        assert.equal(h.probed.length, 2);
        assert.equal(first.providers.acme.deferred, 2);
        assert.equal([...h.db.values()].filter((entry) => entry.probeStatus === "untested").length, 2);
        await h.run();
        assert.equal(h.probed.length, 4);
        assert.deepEqual([...h.db.values()].filter((entry) => entry.probeStatus === "untested"), []);
    });

    await check("a run with nothing new saves nothing and sends nothing", async () => {
        const h = harness({ rows: [pinned()].map((entry) => ({ ...entry, lastSeenAt: iso(START), probedAt: iso(START - DAY) })), listings: { acme: okListing("acme/pinned") } });
        const summary = await h.run();
        assert.equal(h.saved.length, 0);
        assert.deepEqual(h.probed, []);
        assert.equal(h.notifications.length, 0);
        assert.equal(summary.notified, false);
    });

    await check("retired alias rows are never counted, probed or re-added", async () => {
        const nim = PROVIDERS.find((provider) => provider.id === "nvidia-nim")!;
        const retiredId = [...retiredChatModelIds("nvidia-nim")][0];
        assert.ok(retiredId);
        const retiredRow = row({ providerId: "nvidia-nim", modelId: retiredId, origin: "seed", approvedAt: iso(START - 30 * DAY), probedAt: null, probeStatus: "untested" });
        const codeRows = nim.chatModels.map((model) => row({ providerId: "nvidia-nim", modelId: model.id, origin: "seed", shortName: model.name, approvedAt: iso(START - 30 * DAY), lastSeenAt: iso(START) }));
        const h = harness({ providers: [nim], rows: [retiredRow, ...codeRows], listings: { "nvidia-nim": okListing(...nim.chatModels.map((model) => model.id), retiredId) } });
        const summary = await h.run();
        assert.deepEqual(h.db.get(`nvidia-nim::${retiredId}`), retiredRow);
        assert.ok(!h.probed.includes(`nvidia-nim::${retiredId}`));
        assert.deepEqual(summary.added, []);
        const notListed = harness({ providers: [nim], rows: [retiredRow, ...codeRows], listings: { "nvidia-nim": okListing(...nim.chatModels.map((model) => model.id)) } });
        await notListed.run();
        await notListed.run();
        assert.deepEqual(notListed.db.get(`nvidia-nim::${retiredId}`), retiredRow);
        assert.equal(notListed.notifications.length, 0);
    });

    await check("free picker models are re-tested after 7 days; recent and paid ones are not", async () => {
        const stale = row({ providerId: "acme", modelId: "acme/stale", approvedAt: iso(START - 30 * DAY), probedAt: iso(START - 8 * DAY) });
        const recent = row({ providerId: "acme", modelId: "acme/recent", approvedAt: iso(START - 30 * DAY), probedAt: iso(START - 2 * DAY) });
        const paid = row({ providerId: "acme", modelId: "acme/paid", free: false, metered: true, approvedAt: iso(START - 30 * DAY), probedAt: iso(START - 30 * DAY) });
        const failedUnapproved = row({ providerId: "acme", modelId: "acme/failed", probeStatus: "failed", probedAt: iso(START - 30 * DAY) });
        const neverProbedSeed = { ...pinned(), probeStatus: "untested" as const, probedAt: null };
        const listing = okListing("acme/pinned", "acme/stale", "acme/recent", "acme/failed");
        if (listing.ok) listing.models.push(listed("acme/paid", false));
        const h = harness({ rows: [neverProbedSeed, stale, recent, paid, failedUnapproved], listings: { acme: listing } });
        await h.run();
        assert.deepEqual(h.probed, ["acme::acme/pinned", "acme::acme/stale"]);
    });

    await check("a removed model is still tracked for Missing but never tested or announced", async () => {
        const stale = row({ providerId: "acme", modelId: "acme/stale", approvedAt: iso(START - 30 * DAY), probedAt: iso(START - 8 * DAY) });
        const fresh = row({ providerId: "acme", modelId: "acme/fresh", probeStatus: "untested", probedAt: null });
        const h = harness({ rows: [pinned(), stale, fresh], listings: { acme: okListing("acme/stale", "acme/fresh") }, removed: ["acme::acme/pinned", "acme::acme/stale", "acme::acme/fresh"] });
        await h.run();
        const second = await h.run();
        assert.deepEqual(h.probed, []);
        assert.equal(h.db.get("acme::acme/pinned")!.missingSince, iso(START), "Missing still counts, which is what makes Delete available");
        assert.deepEqual(second.newlyMissing, []);
        assert.equal(h.notifications.length, 0);
    });

    await check("new models are probed before re-tests when the cap is tight", async () => {
        const stale = row({ providerId: "acme", modelId: "acme/stale", approvedAt: iso(START - 30 * DAY), probedAt: iso(START - 8 * DAY) });
        const h = harness({ rows: [{ ...pinned(), probedAt: iso(START - DAY) }, stale], listings: { acme: okListing("acme/pinned", "acme/stale", "acme/new") }, maxProbes: 1 });
        await h.run();
        assert.deepEqual(h.probed, ["acme::acme/new"]);
    });

    await check("inconclusive probes retry, and the third in a row fails", async () => {
        const h = harness({ rows: [pinned()], listings: { acme: okListing("acme/pinned", "acme/slow") }, probe: () => probeResult("inconclusive") });
        await h.run();
        assert.equal(h.db.get("acme::acme/slow")!.probeStatus, "inconclusive");
        assert.equal(h.db.get("acme::acme/slow")!.probeAttempts, 1);
        await h.run();
        await h.run();
        assert.equal(h.db.get("acme::acme/slow")!.probeStatus, "failed");
        assert.equal(h.db.get("acme::acme/slow")!.probeAttempts, 3);
        await h.run();
        assert.equal(h.probed.filter((key) => key === "acme::acme/slow").length, 3, "a failed unapproved model is not probed again");
        assert.equal(h.notifications.length, 0, "an unapproved model failing is not news");
    });

    await check("one inconclusive re-test does not demote a passed model", () => {
        const passed = row({ providerId: "acme", modelId: "acme/ok" });
        const next = applyProbe(passed, probeResult("inconclusive"), iso(START));
        assert.equal(next.probeStatus, "passed");
        assert.equal(next.probeAttempts, 1);
        assert.equal(next.probeChatMs, 900);
    });

    await check("a 410 marks the model failed and missing at once, and still being listed does not clear it", async () => {
        const h = harness({ rows: [pinned()], listings: { acme: okListing("acme/pinned", "acme/gone") }, probe: () => probeResult("failed", { retired: true }) });
        await h.run();
        const gone = h.db.get("acme::acme/gone")!;
        assert.equal(gone.probeStatus, "failed");
        assert.equal(gone.missingSince, iso(START));
        await h.run();
        assert.equal(h.db.get("acme::acme/gone")!.missingSince, iso(START));
    });

    await check("an approved model that fails its re-test is reported once", async () => {
        const approved = row({ providerId: "acme", modelId: "acme/approved", approvedAt: iso(START - 30 * DAY), probedAt: iso(START - 8 * DAY) });
        const h = harness({ rows: [{ ...pinned(), probedAt: iso(START - DAY) }, approved], listings: { acme: okListing("acme/pinned", "acme/approved") }, probe: () => probeResult("failed") });
        const summary = await h.run();
        assert.deepEqual(summary.failedRetests, ["acme::acme/approved"]);
        assert.match(h.notifications[0], /Approved models that failed a re-test \(1\):\n- Acme: Label acme\/approved \(`approved`\)/);
        const aged = [...h.db.values()].map((entry) => entry.modelId === "acme/approved" ? { ...entry, probedAt: iso(START - 8 * DAY) } : entry);
        const later = harness({ rows: aged, listings: { acme: okListing("acme/pinned", "acme/approved") }, probe: () => probeResult("failed") });
        await later.run();
        assert.deepEqual(later.probed, ["acme::acme/approved"]);
        assert.equal(later.notifications.length, 0, "failing again is not a change");
    });

    await check("an undelivered message leaves missing notices for the next run", async () => {
        const h = harness({ rows: [{ ...pinned(), missedChecks: 1 }], listings: { acme: okListing("acme/other-listed") }, notifyOk: false });
        const summary = await h.run();
        assert.equal(summary.notified, false);
        assert.equal(h.db.get("acme::acme/pinned")!.notifiedMissingAt, null);
        assert.equal(h.notifications.length, 1);
    });

    await check("the time budget stops new probes and counts the rest as deferred", async () => {
        const h = harness({ rows: [pinned()], listings: { acme: okListing("acme/pinned", "acme/a", "acme/b", "acme/c") }, tick: 60_000, runBudgetMs: 5 * 60_000 });
        const summary = await h.run();
        assert.ok(h.probed.length > 0 && h.probed.length < 3, `probed ${h.probed.length}`);
        assert.equal(summary.budgetReached, true);
        assert.equal((summary.providers.acme.probed ?? 0) + (summary.providers.acme.deferred ?? 0), 3);
    });

    await check("a crashed probe counts as inconclusive and the run still finishes", async () => {
        const h = harness({ rows: [pinned()], listings: { acme: okListing("acme/pinned", "acme/boom") }, probe: () => { throw new Error("socket hang up"); } });
        const summary = await h.run();
        assert.equal(h.db.get("acme::acme/boom")!.probeStatus, "inconclusive");
        assert.equal(summary.providers.acme.inconclusive, 1);
        assert.equal(h.finished[0].status, "done");
    });

    await check("a storage failure finishes the run row as failed", async () => {
        const h = harness({});
        h.deps.readRows = async () => ({ ok: false, reason: "migration_required" });
        const summary = await executeDiscovery("run-1", "cron", h.deps);
        assert.equal(summary, null);
        assert.equal(h.finished[0].status, "failed");
        assert.match(String(h.finished[0].summary.error), /v7-model-catalogue\.sql/);
    });

    await check("Test probes one paid model, stores its detail and sends no message", async () => {
        const paid = row({ providerId: "acme", modelId: "acme/paid", free: false, metered: true, probeStatus: "untested", probedAt: null });
        const h = harness({ rows: [paid] });
        const summary = await executeModelTest("run-1", "acme", "acme/paid", h.deps);
        assert.equal(summary?.status, "passed");
        assert.deepEqual(h.probed, ["acme::acme/paid"]);
        assert.ok(h.saved[0][0].probeDetail);
        assert.equal(h.notifications.length, 0);
        assert.equal(h.finished[0].summary.kind, "test");
        const missing = await executeModelTest("run-1", "acme", "acme/nope", h.deps);
        assert.equal(missing, null);
        assert.equal(h.finished[1].status, "failed");
    });

    await check("the message stays short when many models change", () => {
        const many = Array.from({ length: 40 }, (_, index) => `Acme: Model ${index} (\`model-${index}\`)`);
        const text = discoveryMessage({ passed: many, missing: many, failedRetests: [], listingFailed: [] }, "https://owner.invalid/admin#models")!;
        assert.ok(text.length < 2000, `message is ${text.length} characters`);
        assert.match(text, /and 28 more/);
        assert.equal(discoveryMessage({ passed: [], missing: [], failedRetests: [], listingFailed: [] }, "x"), null);
    });

    await check("MODEL_DISCOVERY_MAX_PROBES falls back to 10 unless it is a whole number from 0 to 50", () => {
        assert.equal(maxProbesFromEnv(undefined), 10);
        assert.equal(maxProbesFromEnv(""), 10);
        assert.equal(maxProbesFromEnv("3"), 3);
        assert.equal(maxProbesFromEnv("0"), 0);
        assert.equal(maxProbesFromEnv("2.5"), 10);
        assert.equal(maxProbesFromEnv("500"), 10);
    });

    await check("the lock clears a run older than 30 minutes before taking its own", async () => {
        const requests: { method: string; url: URL; body: unknown }[] = [];
        supabaseHandler = (url, init) => {
            requests.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
            if (init?.method === "PATCH") return new Response(null, { status: 204 });
            return Response.json({ id: "33333333-3333-4333-8333-333333333333" }, { status: 201 });
        };
        const before = Date.now();
        const result = await startDiscoveryRun("cron");
        assert.deepEqual(result, { ok: true, runId: "33333333-3333-4333-8333-333333333333" });
        const [clear, insert] = requests;
        assert.equal(clear.method, "PATCH");
        assert.equal(clear.url.pathname, "/rest/v1/model_discovery_runs");
        assert.equal(clear.url.searchParams.get("status"), "eq.running");
        const cutoff = Date.parse(clear.url.searchParams.get("started_at")!.replace(/^lt\./, ""));
        assert.ok(Math.abs(before - 30 * 60_000 - cutoff) < 5000, "cutoff is 30 minutes ago");
        assert.equal((clear.body as { status: string }).status, "failed");
        assert.equal(insert.method, "POST");
        assert.deepEqual(insert.body, { trigger: "cron", status: "running" });
    });

    await check("a held lock reports busy and a missing table reports the migration", async () => {
        supabaseHandler = (_url, init) => init?.method === "PATCH"
            ? new Response(null, { status: 204 })
            : Response.json({ code: "23505", message: "duplicate key value violates unique constraint" }, { status: 409 });
        assert.deepEqual(await startDiscoveryRun("manual"), { ok: false, reason: "busy" });
        supabaseHandler = () => Response.json({ code: "PGRST205", message: "Could not find the table" }, { status: 404 });
        assert.deepEqual(await startDiscoveryRun("manual"), { ok: false, reason: "migration_required" });
    });

    await check("saving keeps stored probe detail on rows that were not probed", async () => {
        const bodies: Record<string, unknown>[][] = [];
        supabaseHandler = (url, init) => {
            assert.equal(url.searchParams.get("on_conflict"), "provider_id,model_id");
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(null, { status: 201 });
        };
        await saveCatalogueRows([
            { row: row({ providerId: "acme", modelId: "acme/probed" }), probeDetail: { steps: {} } },
            { row: row({ providerId: "acme", modelId: "acme/listed" }) },
        ], iso(START));
        assert.equal(bodies.length, 2);
        assert.ok("probe_detail" in bodies[0][0]);
        assert.ok(!("probe_detail" in bodies[1][0]));
        assert.ok(!("approved_at" in bodies[0][0]) && !("approved_at" in bodies[1][0]), "a run never writes approvals");
    });

    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../src/proxy");
    const cron = await import("../src/app/api/cron/model-discovery/route");
    const refresh = await import("../src/app/api/admin/models/refresh/route");
    const models = await import("../src/app/api/admin/models/route");
    const { createSessionValue } = await import("../src/lib/auth/session");
    const { AUTH_COOKIE } = await import("../src/lib/auth/config");

    await check("the cron route needs CRON_SECRET and does nothing when MODEL_DISCOVERY is off", async () => {
        const url = "https://fixture.invalid/api/cron/model-discovery";
        assert.equal((await cron.POST(new NextRequest(url, { method: "POST" }))).status, 401);
        assert.equal((await cron.POST(new NextRequest(url, { method: "POST", headers: { authorization: "Bearer wrong" } }))).status, 401);
        process.env.MODEL_DISCOVERY = "off";
        try {
            assert.equal((await cron.POST(new NextRequest(url, { method: "POST", headers: { authorization: "Bearer fixture-cron" } }))).status, 204);
        } finally {
            delete process.env.MODEL_DISCOVERY;
        }
    });

    await check("proxy and the admin routes refuse requests without a session", async () => {
        for (const path of ["/api/admin/models", "/api/admin/models/refresh", "/api/admin/models/test"]) {
            const response = await proxy(new NextRequest(`https://fixture.invalid${path}`, { method: path.endsWith("models") ? "GET" : "POST" }));
            assert.equal(response.status, 307, path);
            assert.match(response.headers.get("location") ?? "", /\/login$/);
        }
        assert.equal((await models.GET(new NextRequest("https://fixture.invalid/api/admin/models"))).status, 401);
        assert.equal((await refresh.POST(new NextRequest("https://fixture.invalid/api/admin/models/refresh", { method: "POST" }))).status, 401);
    });

    await check("Refresh now returns 409 while a run holds the lock", async () => {
        supabaseHandler = (_url, init) => init?.method === "PATCH"
            ? new Response(null, { status: 204 })
            : Response.json({ code: "23505", message: "duplicate key value violates unique constraint" }, { status: 409 });
        const cookie = `${AUTH_COOKIE}=${await createSessionValue()}`;
        const response = await refresh.POST(new NextRequest("https://fixture.invalid/api/admin/models/refresh", { method: "POST", headers: { cookie } }));
        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /already running/);
    });

    await check("Approve refuses a malformed body", async () => {
        const cookie = `${AUTH_COOKIE}=${await createSessionValue()}`;
        const response = await models.PATCH(new NextRequest("https://fixture.invalid/api/admin/models", {
            method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ providerId: "acme", modelId: "acme/x", approved: "yes" }),
        }));
        assert.equal(response.status, 400);
    });
} finally {
    globalThis.fetch = realFetch;
}

console.log(`${checks} catalogue run checks passed`);
