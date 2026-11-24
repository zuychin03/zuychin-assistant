// Offline checks for V8 F1 reranking: model order, ties, every fallback, the reply details line and the pre-V8 keyword
// order. Every request goes to a fake fetch; no live services or database.
import assert from "node:assert/strict";
import { rankingOf, recordRanking, rerank, resolveReranker, type RerankOptions } from "../src/lib/ai/rerank";
import { graphSearchPages } from "../src/lib/vault/page-hits";
import { keywordRank, keywordTieBreak } from "../src/lib/ai/keyword-rank";
import { describeRanking } from "../src/lib/ai/reply-notes";
import { withReplySources } from "../src/lib/ai/reply-sources";
import { makeReplyTrace, mergeReplyTrace, type ReplyRanking } from "../src/lib/ai/reply-trace";
import { collectModelObservations, configureModelDataPolicy } from "../src/lib/ai/model-observations";
import { setCatalogueSnapshotForTests, type CatalogueRow } from "../src/lib/ai/catalogue/snapshot";
import { setMediaChoicesForTests } from "../src/lib/ai/media/choices";
import { getProvider } from "../src/lib/ai/providers";
import type { ResolvedMedia } from "../src/lib/ai/media/resolve";

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const MODEL_ID = "nvidia/nemotron-3.5-rerank-8b";
function row(overrides: Partial<CatalogueRow> = {}): CatalogueRow {
    return {
        providerId: "nvidia-nim", modelId: MODEL_ID, kind: "rerank", origin: "seed", label: "Nemotron 3.5 Rerank 8B (free)", shortName: "nemotron-3.5-rerank-8b",
        description: null, developer: null, free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: [], listedTools: null,
        listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 400,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null, firstSeenAt: "2026-11-20T00:00:00.000Z",
        lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null, approvedAt: "2026-11-24T00:00:00.000Z",
        dimension: null, expiresAt: null, expiresSource: null, notifiedExpiryDays: null, expiryCheckedAt: null, spaceOf: null, traits: {},
        ...overrides,
    };
}
const resolved = (entry = row()): ResolvedMedia => ({ provider: getProvider("nvidia-nim")!, row: entry, modelId: entry.modelId, apiKey: "fixture-key" });

type Call = { url: string; body: { query: { text: string }; passages: { text: string }[] } };
function ranking(logits: number[], calls: Call[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ rankings: logits.map((logit, index) => ({ index, logit })).sort((a, b) => b.logit - a.logit) }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
}
const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
const hang: typeof fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) return reject(init.signal.reason);
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
})) as typeof fetch;

// AbortSignal.timeout does not hold the event loop open on its own.
async function alive<T>(work: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {}, 20);
    try { return await work(); } finally { clearInterval(timer); }
}

interface Memory { id: string; content: string; metadata?: Record<string, string>; similarity?: number }
const options = (fetchImpl: typeof fetch, extra: Partial<RerankOptions<Memory>> = {}): RerankOptions<Memory> =>
    ({ freeOnly: false, route: resolved(), fetchImpl, text: (item) => item.content, ...extra });
const memories: Memory[] = [
    { id: "a", content: "Bought milk on Tuesday", similarity: 0.71 },
    { id: "b", content: "The capstone starts on 02/11/2026 with InnovAIte", similarity: 0.69, metadata: { source: "user_message" } },
    { id: "c", content: "Capstone kickoff notes and the AAIE project scope", similarity: 0.66 },
    { id: "d", content: "Weekend hike plan", similarity: 0.62 },
];

// rerankResults from src/lib/ai/rag-service.ts as it was before V8, kept here as the reference for the fallback order.
function legacyRank(results: Memory[], query: string, maxResults: number) {
    const queryTerms = new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
    const scored = results.map((r) => {
        const cosineSim = r.similarity ?? 0.7;
        const contentLower = r.content.toLowerCase();
        let keywordHits = 0;
        for (const term of queryTerms) {
            if (contentLower.includes(term)) keywordHits++;
        }
        const keywordScore = queryTerms.size > 0 ? (keywordHits / queryTerms.size) * 0.2 : 0;
        const source = r.metadata?.source ?? "";
        const recencyBonus = source === "user_message" ? 0.05 : 0;
        return { ...r, totalScore: cosineSim + keywordScore + recencyBonus };
    });
    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored.slice(0, maxResults);
}

await check("the model's order is applied and the request carries the query and every passage", async () => {
    const calls: Call[] = [];
    const outcome = await rerank("when does the capstone start", memories, options(ranking([-4, 6.5, 3.1, -7], calls)));
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.items.map((item) => item.id), ["b", "c", "a", "d"]);
    assert.deepEqual(outcome.scores, [6.5, 3.1, -4, -7]);
    assert.equal(outcome.model, "Nemotron 3.5 Rerank 8B (free)");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://ai.api.nvidia.com/v1/retrieval/${MODEL_ID}/reranking`);
    assert.equal(calls[0].body.query.text, "when does the capstone start");
    assert.deepEqual(calls[0].body.passages.map((passage) => passage.text), memories.map((memory) => memory.content));
});

await check("ties in model score go to the keyword score, then to the input order", async () => {
    const query = "capstone project scope";
    const tied = await rerank(query, memories, options(ranking([1, 2, 2, 1]), { tieBreak: keywordTieBreak(query) }));
    assert.ok(tied.ok);
    assert.deepEqual(tied.items.map((item) => item.id), ["c", "b", "a", "d"], "c matches more query terms than b");
    const plain = await rerank(query, memories, options(ranking([1, 2, 2, 1])));
    assert.ok(plain.ok);
    assert.deepEqual(plain.items.map((item) => item.id), ["b", "c", "a", "d"]);
});

await check("passages and the query are trimmed to one line and cut to size", async () => {
    const calls: Call[] = [];
    const long = [{ id: "x", content: `first\n\n  line ${"word ".repeat(1000)}` }, { id: "y", content: "   " }];
    await rerank(`  ${"q".repeat(1500)}  `, long, options(ranking([0, 1], calls)));
    assert.equal(calls[0].body.passages[0].text.length, 2000);
    assert.ok(calls[0].body.passages[0].text.startsWith("first line word"));
    assert.equal(calls[0].body.passages[1].text, "-", "an empty passage is never sent empty");
    assert.equal(calls[0].body.query.text.length, 1000);
});

await check("fallbacks: too few items, no model, failure, a bad reply and a timeout", async () => {
    const calls: Call[] = [];
    assert.deepEqual(await rerank("q", memories.slice(0, 1), options(ranking([1], calls))), { ok: false, reason: "few" });
    assert.deepEqual(await rerank("   ", memories, options(ranking([1, 2, 3, 4], calls))), { ok: false, reason: "few" });
    assert.equal(calls.length, 0, "nothing is sent for one item or an empty query");
    assert.deepEqual(await rerank("q", memories, options(ranking([1, 2, 3, 4]), { route: null })), { ok: false, reason: "off" });
    const failed = await rerank("q", memories, options(reply(503, { detail: "busy" })));
    assert.deepEqual([failed.ok, !failed.ok && failed.reason, !failed.ok && failed.model], [false, "failed", "Nemotron 3.5 Rerank 8B (free)"]);
    const partial = await rerank("q", memories, options(reply(200, { rankings: [{ index: 0, logit: 1 }, { index: 1, logit: 0 }] })));
    assert.equal(!partial.ok && partial.reason, "failed", "a reply that drops passages is not used");
    const started = performance.now();
    const slow = await alive(() => rerank("q", memories, options(hang, { timeoutMs: 80 })));
    assert.equal(!slow.ok && slow.reason, "timeout");
    assert.ok(performance.now() - started < 1_000, "the timeout ends the wait");
});

await check("the caller's abort is thrown, not turned into a fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(rerank("q", memories, options(hang, { signal: controller.signal })), (error: unknown) => (error as Error).name === "AbortError");
});

await check("the call is observed as a rerank call, and a refused data route sends nothing", async () => {
    setCatalogueSnapshotForTests([row(), row({ modelId: "nvidia/paid-rerank", free: false, label: "Paid rerank" })]);
    const sent: Call[] = [];
    const { value, observations } = await collectModelObservations(async () => {
        configureModelDataPolicy(false);
        return rerank("capstone", memories, options(ranking([1, 2, 3, 4], sent)));
    }, ["personal"]);
    assert.ok(value.ok);
    assert.deepEqual(observations.map((entry) => [entry.purpose, entry.status, entry.modelId, entry.dataRoute?.rule]), [["rerank", "success", MODEL_ID, "interactive"]]);

    const refused = await collectModelObservations(async () => {
        configureModelDataPolicy(true);
        return rerank("capstone", memories, options(ranking([1, 2, 3, 4], sent), { route: resolved(row({ modelId: "nvidia/paid-rerank", free: false, label: "Paid rerank" })) }));
    }, ["personal"]);
    assert.deepEqual(refused.value, { ok: false, reason: "refused", model: "Paid rerank" });
    assert.equal(sent.length, 1, "Free only never sends to a paid rerank model");

    const failed = await collectModelObservations(async () => {
        configureModelDataPolicy(false);
        return rerank("capstone", memories, options(reply(429, { detail: "slow down" })));
    }, ["personal", "unattended"]);
    assert.deepEqual(failed.observations.map((entry) => [entry.status, entry.httpStatus, entry.dataRoute?.rule]), [["rate_limit", 429, "unattended_scoring"]]);
    setCatalogueSnapshotForTests([]);
});

await check("resolution: an approved rerank row with a key is used; MEDIA_KINDS=off and Free only without a free row fall back", async () => {
    const previousKey = process.env.NVIDIA_NIM_API_KEY, previousKinds = process.env.MEDIA_KINDS;
    process.env.NVIDIA_NIM_API_KEY = "fixture-key";
    delete process.env.MEDIA_KINDS;
    setMediaChoicesForTests({});
    try {
        setCatalogueSnapshotForTests([row()]);
        assert.equal((await resolveReranker(false))?.modelId, MODEL_ID);
        const outcome = await rerank("capstone", memories, { freeOnly: false, fetchImpl: ranking([0, 3, 2, 1]), text: (item) => item.content });
        assert.deepEqual(outcome.ok && outcome.items.map((item) => item.id), ["b", "c", "d", "a"]);
        process.env.MEDIA_KINDS = "off";
        assert.equal(await resolveReranker(false), null);
        delete process.env.MEDIA_KINDS;
        setCatalogueSnapshotForTests([row({ free: false })]);
        assert.equal(await resolveReranker(true), null);
        setCatalogueSnapshotForTests([row({ approvedAt: null })]);
        assert.equal(await resolveReranker(false), null, "an unapproved model is never used");
    } finally {
        if (previousKey === undefined) delete process.env.NVIDIA_NIM_API_KEY; else process.env.NVIDIA_NIM_API_KEY = previousKey;
        if (previousKinds === undefined) delete process.env.MEDIA_KINDS; else process.env.MEDIA_KINDS = previousKinds;
        setCatalogueSnapshotForTests([]);
    }
});

await check("the keyword fallback ranks exactly as before V8", () => {
    const query = "When does the capstone project start";
    assert.deepEqual(keywordRank(memories, query, 3), legacyRank(memories, query, 3));
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const words = ["capstone", "project", "milk", "hike", "start", "notes", "scope", "the", "when"];
    for (let round = 0; round < 50; round++) {
        const pool: Memory[] = Array.from({ length: 2 + Math.floor(random() * 10) }, (_, index) => ({
            id: `${round}-${index}`,
            content: Array.from({ length: 1 + Math.floor(random() * 6) }, () => words[Math.floor(random() * words.length)]).join(" "),
            ...(random() > 0.2 ? { similarity: Math.round(random() * 100) / 100 } : {}),
            ...(random() > 0.5 ? { metadata: { source: random() > 0.5 ? "user_message" : "mcp_save_note" } } : {}),
        }));
        const q = Array.from({ length: 1 + Math.floor(random() * 4) }, () => words[Math.floor(random() * words.length)]).join(" ");
        assert.deepEqual(keywordRank(pool, q, 3), legacyRank(pool, q, 3), `round ${round}`);
    }
});

await check("the reply details say how each list was ordered, and a fallback says why", () => {
    const model = rankingOf("memories", { ok: true, items: [1, 2], scores: [2, 1], model: "Nemotron 3.5 Rerank 8B (free)", ms: 412.6 }, 24)!;
    assert.equal(describeRanking(model), "Memories: reranked by Nemotron 3.5 Rerank 8B (free) (24 candidates, 413 ms).");
    assert.equal(describeRanking(rankingOf("knowledge", { ok: false, reason: "off" }, 4)!), "Knowledge: keyword ranking, because no rerank model is in use.");
    assert.equal(describeRanking(rankingOf("vault", { ok: false, reason: "timeout", model: "X", ms: 1500 }, 24)!), "Vault search: keyword ranking, because the rerank model was too slow.");
    assert.equal(rankingOf("memories", { ok: false, reason: "few" }, 1), null, "nothing to order, nothing to note");

    const rankings: ReplyRanking[] = [];
    withReplySources([], () => {
        for (let index = 0; index < 8; index++) recordRanking("vault", { ok: false, reason: "failed" }, 3);
        recordRanking("memories", { ok: false, reason: "few" }, 1);
    }, new Set(), rankings);
    assert.equal(rankings.length, 6, "capped, so a long agent run cannot grow the trace");
    recordRanking("memories", { ok: false, reason: "off" }, 3);
    assert.equal(rankings.length, 6, "outside a reply nothing is recorded");

    const first = makeReplyTrace({ origin: "interactive", freeOnly: false, startedAt: "2026-11-24T00:00:00.000Z", durationMs: 10, firstAnswerMs: 5, calls: [], externalServices: [], background: "pending", ranking: [model] });
    const later = makeReplyTrace({ origin: "interactive", freeOnly: false, startedAt: "2026-11-24T00:00:00.000Z", durationMs: 10, firstAnswerMs: 5, calls: [], externalServices: [], background: "complete" });
    assert.deepEqual(mergeReplyTrace(first, later).ranking, [model], "background updates keep the ranking lines");
});

// The /api/vault/search page merge as it was before V8, kept here as the reference.
function legacyGraphPages(hits: { path: string; title: string; similarity: number; score?: { final: number } }[]) {
    const best = new Map<string, { path: string; title: string; similarity: number }>();
    for (const hit of hits) {
        const similarity = Math.max(0, Math.min(1, hit.score?.final ?? hit.similarity));
        const current = best.get(hit.path);
        if (!current || similarity > current.similarity) best.set(hit.path, { path: hit.path, title: hit.title, similarity });
    }
    return [...best.values()].sort((a, b) => b.similarity - a.similarity);
}

await check("graph search rows: unchanged without a model; the model's order survives the client's sort by score", () => {
    const hit = (path: string, final: number) => ({ path, title: path.toUpperCase(), similarity: final / 2, score: { final } });
    const recall = [hit("a.md", 1.2), hit("b.md", 0.62), hit("a.md", 0.6), hit("c.md", 0.55), hit("d.md", 0.55), hit("b.md", 0.4), hit("e.md", 0)];
    assert.deepEqual(graphSearchPages(recall), legacyGraphPages(recall));
    const vectorOnly = [{ path: "x.md", title: "X", similarity: 0.7 }, { path: "y.md", title: "Y", similarity: 0.5 }, { path: "x.md", title: "X", similarity: 0.45 }];
    assert.deepEqual(graphSearchPages(vectorOnly), legacyGraphPages(vectorOnly));

    const reranked = [hit("c.md", 0.55), hit("a.md", 0.6), hit("b.md", 0.62), hit("a.md", 1.2), hit("e.md", 0), hit("d.md", 0.55)];
    const rows = graphSearchPages(reranked);
    assert.deepEqual(rows.map((row) => row.path), ["c.md", "a.md", "b.md", "e.md", "d.md"]);
    assert.deepEqual(rows.map((row) => row.similarity), [0.62, 0.6, 0.55, 0.55, 0]);
    assert.deepEqual([...rows].sort((a, b) => b.similarity - a.similarity).map((row) => row.path), rows.map((row) => row.path), "a stable sort by score keeps the model's order");
});

console.log(`${checks} rerank checks passed`);
