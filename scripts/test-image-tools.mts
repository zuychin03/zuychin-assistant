// Offline checks for V8 F10 make_image and F11 images for the consult tools: the tool shows only with a usable image
// model, shapes, the 422 fallback, the saved artifact, Free only, and how chat hands an attached image to the agent.
// Every model call and artifact write is a fake; no live services or database.
import assert from "node:assert/strict";
import type { CatalogueRow } from "../src/lib/ai/catalogue/snapshot";
import type { ResolvedMedia } from "../src/lib/ai/media/resolve";
import type { GeneratedImage, MediaResult } from "../src/lib/ai/media/requests";
import type { ImageToolDeps } from "../src/lib/ai/tools/images";
import type { ArtifactDescriptor, FileAttachment } from "../src/lib/types";

// The artifact store and chat modules build a Supabase client on import; nothing here reaches it.
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://image-tools.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture", GEMINI_API_KEY: "fixture", AUTH_SESSION_SECRET: "fixture" });
const { PROVIDERS, getProvider } = await import("../src/lib/ai/providers");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { setMediaChoicesForTests } = await import("../src/lib/ai/media/choices");
const { resolveModelOfKind } = await import("../src/lib/ai/media/resolve");
const { executeImageTool, imageTools, IMAGE_PROMPT_MAX, MAKE_IMAGE_TOOL } = await import("../src/lib/ai/tools/images");
const { buildGeminiFunctionDeclarations, buildOpenAIToolDeclarations } = await import("../src/lib/ai/mcp-service");
const { freeToolRefusal } = await import("../src/lib/ai/model-policy");
const { attachedImages } = await import("../src/lib/ai/rag-service");
const { imageNote } = await import("../src/lib/ai/agent/orchestrator");

for (const provider of PROVIDERS) process.env[provider.apiKeyEnv] = "image-tools-test-key";
delete process.env.IMAGE_TOOLS;
delete process.env.MEDIA_KINDS;
setMediaChoicesForTests({});

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const MODEL_ID = "black-forest-labs/flux.2-klein-4b";
function row(overrides: Partial<CatalogueRow> = {}): CatalogueRow {
    return {
        providerId: "nvidia-nim", modelId: MODEL_ID, kind: "image", origin: "seed", label: "FLUX.2 klein 4B (free)", shortName: "flux.2-klein-4b",
        description: null, developer: null, free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: ["Text"], listedTools: null,
        listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-25T00:00:00.000Z", probeChatMs: 4000,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null, firstSeenAt: "2026-11-24T00:00:00.000Z",
        lastSeenAt: "2026-11-25T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null, approvedAt: "2026-11-25T00:00:00.000Z",
        dimension: null, expiresAt: null, expiresSource: null, notifiedExpiryDays: null, expiryCheckedAt: null, spaceOf: null, traits: { sizes: ["1024x1024"] },
        ...overrides,
    };
}
const route = (entry = row()): ResolvedMedia => ({ provider: getProvider("nvidia-nim")!, row: entry, modelId: entry.modelId, apiKey: "fixture-key" });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(2044).fill(7)]);
const made = (): MediaResult<GeneratedImage> => ({ ok: true, value: { bytes: JPEG, mimeType: "image/jpeg" }, status: 200, ms: 3200 });
const failed = (status: number, error: string): MediaResult<GeneratedImage> => ({ ok: false, status, ms: 300, error, transient: false, timedOut: false, retiredAt: null });

type Saved = Parameters<ImageToolDeps["save"]>[0];
function fakes(results: MediaResult<GeneratedImage>[], overrides: Partial<ImageToolDeps> = {}) {
    const asked: { prompt: string; width: number; height: number }[] = [];
    const saved: Saved[] = [];
    const resolvedFor: boolean[] = [];
    const deps: ImageToolDeps = {
        resolve: async (freeOnly) => { resolvedFor.push(freeOnly); return route(); },
        generate: async (_route, input) => { asked.push(input); return results.shift() ?? made(); },
        save: async (params) => { saved.push(params); return { id: "art-1", name: params.filename, mime: params.mimeType, kind: params.kind, size: (params.body as Buffer).length }; },
        ...overrides,
    };
    return { deps, asked, saved, resolvedFor };
}
const toolNames = () => ({
    gemini: buildGeminiFunctionDeclarations().map((tool) => tool.name),
    openai: buildOpenAIToolDeclarations().map((tool) => tool.function.name),
});

await check("make_image is declared only while an approved, passed image model can be called", () => {
    setCatalogueSnapshotForTests([row()]);
    assert.deepEqual(imageTools().map((tool) => tool.name), ["make_image"]);
    assert.ok(toolNames().gemini.includes("make_image") && toolNames().openai.includes("make_image"), "chat tool lists carry it");
    for (const [name, rows] of [
        ["no image row", []],
        ["unapproved", [row({ approvedAt: null })]],
        ["failed probe", [row({ probeStatus: "failed" })]],
        ["a chat row only", [row({ kind: "chat" })]],
    ] as const) {
        setCatalogueSnapshotForTests(rows);
        assert.deepEqual(imageTools(), [], name);
        assert.ok(!toolNames().gemini.includes("make_image") && !toolNames().openai.includes("make_image"), name);
    }
    setCatalogueSnapshotForTests([row()]);
    process.env.IMAGE_TOOLS = "off";
    assert.deepEqual(imageTools(), [], "IMAGE_TOOLS=off hides it");
    process.env.IMAGE_TOOLS = "on";
    process.env.MEDIA_KINDS = "off";
    assert.deepEqual(imageTools(), [], "MEDIA_KINDS=off hides it");
    delete process.env.MEDIA_KINDS;
    delete process.env.IMAGE_TOOLS;
    assert.deepEqual(MAKE_IMAGE_TOOL.parameters.size.enum, ["square", "portrait", "landscape"]);
    assert.equal(freeToolRefusal("make_image", true), null, "Free only allows it; the resolver picks a free model");
});

await check("shapes map to the model's sizes and an unknown shape falls back to square", async () => {
    const { deps, asked } = fakes([]);
    for (const size of [undefined, "portrait", "landscape", "huge"]) await executeImageTool("make_image", { prompt: "A lighthouse", size }, undefined, deps);
    assert.deepEqual(asked.map((input) => `${input.width}x${input.height}`), ["1024x1024", "768x1024", "1024x768", "1024x1024"]);
});

await check("the image is saved as an image artifact, shown through onArtifact and described back to the lead", async () => {
    const { deps, saved, resolvedFor } = fakes([]);
    const shown: ArtifactDescriptor[] = [];
    const reply = await executeImageTool("make_image", { prompt: "  A watercolour   lighthouse at dusk!  " },
        { conversationId: "conv-1", userProfileId: "user-1", onArtifact: (art) => shown.push(art) }, deps);
    assert.equal(saved.length, 1);
    assert.deepEqual({ ...saved[0], body: undefined }, {
        kind: "image", filename: "a-watercolour-lighthouse-at-dusk.jpg", mimeType: "image/jpeg", body: undefined, conversationId: "conv-1", userProfileId: "user-1",
    });
    assert.deepEqual(new Uint8Array(saved[0].body as Buffer), JPEG);
    assert.deepEqual(shown.map((art) => art.kind), ["image"]);
    assert.match(reply!, /^Made a 1024 x 1024 image with FLUX\.2 klein 4B \(free\) \(2 KB\)\. It is attached to this reply/);
    assert.deepEqual(resolvedFor, [false]);
    await executeImageTool("make_image", { prompt: "A watercolour of a red bicycle leaning against a blue wooden door" }, undefined, deps);
    await executeImageTool("make_image", { prompt: "日本の猫" }, undefined, deps);
    assert.deepEqual(saved.slice(1).map((params) => params.filename), ["a-watercolour-of-a-red-bicycle-leaning.jpg", "image.jpg"], "names end on a whole word");
    assert.equal(await executeImageTool("save_artifact", {}, undefined, deps), null, "other tools pass through");
});

await check("a refused shape retries once at the probed size; other failures save nothing", async () => {
    const retried = fakes([failed(422, "Unprocessable size.")]);
    const reply = await executeImageTool("make_image", { prompt: "A cat", size: "landscape" }, undefined, retried.deps);
    assert.deepEqual(retried.asked.map((input) => `${input.width}x${input.height}`), ["1024x768", "1024x1024"]);
    assert.match(reply!, /^Made a 1024 x 1024 image/);

    const same = fakes([failed(422, "Unprocessable size.")]);
    assert.match((await executeImageTool("make_image", { prompt: "A cat" }, undefined, same.deps))!, /could not make this image: Unprocessable size\. No image was attached/);
    assert.equal(same.asked.length, 1, "no retry when the probed size was the one refused");

    const down = fakes([failed(500, "Server error.")]);
    const shown: ArtifactDescriptor[] = [];
    assert.match((await executeImageTool("make_image", { prompt: "A cat" }, { onArtifact: (art) => shown.push(art) }, down.deps))!, /FLUX\.2 klein 4B \(free\)\) could not make this image: Server error\./);
    assert.equal(down.saved.length + shown.length, 0);

    const unsaved = fakes([], { save: async () => { throw new Error("insert failed"); } });
    const quiet = console.error;
    console.error = () => {};
    try { assert.match((await executeImageTool("make_image", { prompt: "A cat" }, undefined, unsaved.deps))!, /made but could not be saved/); }
    finally { console.error = quiet; }
});

await check("prompts are required, trimmed and capped; turning the tool off stops a stale declaration", async () => {
    const { deps, asked } = fakes([]);
    assert.match((await executeImageTool("make_image", { prompt: "   " }, undefined, deps))!, /`prompt` is required/);
    await executeImageTool("make_image", { prompt: `${"x".repeat(IMAGE_PROMPT_MAX)}tail` }, undefined, deps);
    assert.equal(asked[0].prompt.length, IMAGE_PROMPT_MAX);
    process.env.IMAGE_TOOLS = "off";
    try { assert.match((await executeImageTool("make_image", { prompt: "A cat" }, undefined, deps))!, /turned off/); }
    finally { delete process.env.IMAGE_TOOLS; }
    assert.equal(asked.length, 1);
});

await check("Free only resolves only a free image model and says so when there is none", async () => {
    const live = (freeOnly: boolean) => resolveModelOfKind("image", { freeOnly });
    setCatalogueSnapshotForTests([row({ free: false, label: "FLUX.2 klein 4B" })]);
    const paidOnly = fakes([], { resolve: live });
    assert.ok(imageTools().length, "the paid model still shows the tool outside Free only");
    assert.match((await executeImageTool("make_image", { prompt: "A cat" }, { freeOnly: true }, paidOnly.deps))!, /^No image model is available right now in Free only/);
    assert.match((await executeImageTool("make_image", { prompt: "A cat" }, { freeOnly: false }, paidOnly.deps))!, /^Made a .* with FLUX\.2 klein 4B \(/);
    setCatalogueSnapshotForTests([row({ free: false, label: "FLUX.2 klein 4B" }), row({ providerId: "nvidia-nim", modelId: "black-forest-labs/flux.2-klein-9b", label: "FLUX.2 klein 9B (free)" })]);
    const both = fakes([], { resolve: live });
    let usedModel = "";
    both.deps.generate = async (picked) => { usedModel = picked.modelId; return made(); };
    await executeImageTool("make_image", { prompt: "A cat" }, { freeOnly: true }, both.deps);
    assert.equal(usedModel, "black-forest-labs/flux.2-klein-9b");
    setCatalogueSnapshotForTests([row()]);
});

await check("chat hands images to an explicit agent run only when nothing else needs the chat path (F11)", () => {
    const file = (name: string, mimeType: string): FileAttachment => ({ name, mimeType, base64: "ZmlsZQ==", size: 4 });
    assert.deepEqual(attachedImages(undefined, file("mug.png", "image/png")), { list: [{ base64: "ZmlsZQ==", mimeType: "image/png" }], complete: true });
    assert.deepEqual(attachedImages("cGFzdGU=", undefined), { list: [{ base64: "cGFzdGU=", mimeType: "image/jpeg" }], complete: true });
    assert.deepEqual(attachedImages("cGFzdGU=", file("notes.md", "text/markdown")).complete, true, "a text file rides along in the agent message");
    assert.deepEqual(attachedImages("cGFzdGU=", file("report.pdf", "application/pdf")).complete, false, "a PDF keeps the turn in chat");
    assert.deepEqual(attachedImages(undefined, file("notes.md", "text/markdown")), { list: [], complete: false });
    assert.deepEqual(attachedImages("cGFzdGU=", file("mug.webp", "image/webp")).list.map((image) => image.mimeType), ["image/jpeg", "image/webp"]);
    assert.equal(imageNote(0), "");
    assert.match(imageNote(1), /attached an image to this request\. You cannot see it\. ask_model and compare_models send it to vision models/);
    assert.match(imageNote(2), /attached 2 images .* You cannot see them/);
});

console.log(`${checks} image tool checks passed`);
