// Offline checks for same-space backup routes: an approved route that reproduces the knowledge partition takes over
// when the primary fails, and an unapproved, failing or paid one never does.
import assert from "node:assert/strict";
Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://backup-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    NVIDIA_NIM_API_KEY: "fixture-nim", OPENROUTER_API_KEY: "fixture-or", GEMINI_API_KEY: "fixture-gemini",
});
// One backup notice a day; this keeps the test from posting one.
(globalThis as Record<symbol, unknown>)[Symbol.for("zuychin.assistant.embeddingBackupNotice")] = Date.now();

const PRIMARY = "nvidia/nemotron-3.5-embed-1b", COPY = "nvidia/nemotron-3.5-embed-1b:free";
type Call = { host: string; body: Record<string, unknown> };
const calls: Call[] = [];
let nim: () => Response = () => Response.json({ detail: "The model has reached its end of life on 2026-11-23T09:00:00Z" }, { status: 410 });
let router: () => Response = () => Response.json({ data: [{ index: 0, embedding: Array(2048).fill(0.25) }] });
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ host: url.hostname, body });
    if (url.hostname === "integrate.api.nvidia.com") return nim();
    if (url.hostname === "openrouter.ai") return router();
    throw new Error(`Unexpected request to ${url.hostname}`);
};

const { embedText, embedTexts, getEmbeddingRef, sameSpaceBackups } = await import("../src/lib/ai/embeddings");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;

let checks = 0;
async function check(name: string, run: () => void | Promise<void>) {
    calls.length = 0;
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

function embeddingRow(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.replace(/^.*\//, ""), description: null, developer: null,
        free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: ["text"],
        listedTools: null, listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 460,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null,
        firstSeenAt: "2026-11-24T00:00:00.000Z", lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: "2026-11-24T00:00:00.000Z", kind: "embedding", dimension: 2048, spaceOf: null, traits: { acceptsInputType: true, batch: true },
        ...overrides,
    };
}
const primary = embeddingRow({ providerId: "nvidia-nim", modelId: PRIMARY, origin: "seed", traits: { acceptsInputType: true, needsInputType: true, batch: true } });
const copy = (extra: Partial<CatalogueRow> = {}) => embeddingRow({ providerId: "openrouter", modelId: COPY, spaceOf: PRIMARY, ...extra });

await check("a 410 on the primary hands the call to the approved same-space route, input type included", async () => {
    setCatalogueSnapshotForTests([primary, copy()]);
    const ref = getEmbeddingRef();
    assert.equal(ref.model.id, PRIMARY);
    const vector = await embedText(ref, "Which animal jumps?", "query");
    assert.equal(vector.length, 2048);
    assert.deepEqual(calls.map((call) => call.host), ["integrate.api.nvidia.com", "openrouter.ai"], "a 410 is not retried on the primary");
    assert.equal(calls[1].body.model, COPY);
    assert.equal(calls[1].body.input_type, "query", "OpenRouter treats a missing input_type as a query, so it is always sent");
});

await check("a 5xx is retried once on the primary before the backup", async () => {
    nim = () => Response.json({ detail: "busy" }, { status: 503 });
    setCatalogueSnapshotForTests([primary, copy()]);
    await embedText(getEmbeddingRef(), "Bread dough", "passage");
    assert.deepEqual(calls.map((call) => call.host), ["integrate.api.nvidia.com", "integrate.api.nvidia.com", "openrouter.ai"]);
    assert.equal(calls[2].body.input_type, "passage");
});

await check("an unapproved, failing or paid route is never a backup, and a 429 never falls back", async () => {
    nim = () => Response.json({ detail: "gone" }, { status: 410 });
    for (const rows of [[primary, copy({ approvedAt: null })], [primary, copy({ probeStatus: "failed" })], [primary, copy({ free: false })], [primary, copy({ spaceOf: null })]]) {
        setCatalogueSnapshotForTests(rows);
        calls.length = 0;
        await assert.rejects(embedText(getEmbeddingRef(), "text"), /NVIDIA NIM 410/);
        assert.deepEqual(calls.map((call) => call.host), ["integrate.api.nvidia.com"]);
    }
    nim = () => Response.json({ detail: "slow down" }, { status: 429 });
    setCatalogueSnapshotForTests([primary, copy()]);
    calls.length = 0;
    await assert.rejects(embedText(getEmbeddingRef(), "text"), /NVIDIA NIM 429/);
    assert.deepEqual(calls.map((call) => call.host), ["integrate.api.nvidia.com"]);
});

await check("a reduced partition asks the backup for the same size", async () => {
    nim = () => Response.json({ detail: "gone" }, { status: 410 });
    router = () => Response.json({ data: [{ index: 0, embedding: Array(512).fill(0.5) }] });
    setCatalogueSnapshotForTests([primary, copy()]);
    const ref = getEmbeddingRef(`${PRIMARY}@512`);
    const [backup] = sameSpaceBackups(ref);
    assert.equal(backup.model.id, `${PRIMARY}@512`, "writes keep the partition id");
    assert.equal(backup.model.apiId, COPY);
    assert.equal((await embedText(ref, "text")).length, 512);
    assert.equal(calls[0].body.dimensions, 512);
    assert.equal(calls[1].body.dimensions, 512);
});

await check("a healthy primary never touches the backup, and wrong vectors are refused", async () => {
    nim = () => Response.json({ data: [{ index: 0, embedding: Array(2048).fill(0.1) }] });
    setCatalogueSnapshotForTests([primary, copy()]);
    assert.equal((await embedText(getEmbeddingRef(), "text", "query")).length, 2048);
    assert.deepEqual(calls.map((call) => call.host), ["integrate.api.nvidia.com"]);
    assert.equal(calls[0].body.input_type, "query");
    nim = () => Response.json({ data: [{ index: 0, embedding: Array(2048).fill(0) }] });
    await assert.rejects(embedText(getEmbeddingRef(), "text"), /Invalid 2048-dimensional/);
});

await check("a screen refusal never falls back; the text goes past the screen, and a refused batch goes text by text", async () => {
    const inputs = (body: Record<string, unknown>) => [body.input].flat() as string[];
    const screened = (body: Record<string, unknown>) => inputs(body).some((text) => text.includes("https://"));
    nim = () => {
        const body = calls.at(-1)!.body;
        if (screened(body)) return Response.json({ detail: "Input rejected by content safety screening" }, { status: 422 });
        return Response.json({ data: inputs(body).map((_text, index) => ({ index, embedding: Array(2048).fill(0.1) })) });
    };
    setCatalogueSnapshotForTests([primary, copy()]);
    assert.equal((await embedText(getEmbeddingRef(), "See https://example.com/a/very/long/path for the notes")).length, 2048);
    assert.deepEqual(calls.map((call) => call.host), ["integrate.api.nvidia.com", "integrate.api.nvidia.com"], "a 422 is not a backup case");
    assert.deepEqual(inputs(calls[1].body), ["See example.com for the notes"]);
    calls.length = 0;
    const vectors = await embedTexts(getEmbeddingRef(), ["plain one", "link https://example.com/x", "plain two"]);
    assert.equal(vectors.length, 3);
    assert.deepEqual(calls.map((call) => inputs(call.body).length), [3, 1, 1, 1, 1], "batch, then each text alone, the link one twice");
    nim = () => Response.json({ detail: "Input rejected by content safety screening" }, { status: 422 });
    await assert.rejects(embedText(getEmbeddingRef(), "always refused"), /content safety screening/);
});

setCatalogueSnapshotForTests([]);
console.log(`${checks} embedding backup checks passed`);
