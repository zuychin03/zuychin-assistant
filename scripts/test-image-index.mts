// Offline checks for V8 F3 photo search: photo paths and citations, the photo document and its one image chunk, image
// embedding with its text-only fallbacks, the vault photo run, the chunk writer SQL, and the photo route. Fake fetch only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://photo-index.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    AUTH_SESSION_SECRET: "fixture-session", NVIDIA_NIM_API_KEY: "fixture-nim", GITHUB_VAULT_TOKEN: "fixture-vault", GITHUB_VAULT_REPO: "owner/vault",
});
// One backup notice a day; this keeps the test from posting one.
(globalThis as Record<symbol, unknown>)[Symbol.for("zuychin.assistant.embeddingBackupNotice")] = Date.now();

const DIM = 2048;
const IMAGE_VECTOR = Array.from({ length: DIM }, (_, index) => (index === 1 ? 1 : 0));
const TEXT_VECTOR = Array.from({ length: DIM }, (_, index) => (index === 2 ? 3 : 0));
type Body = Record<string, unknown>;
const nimCalls: Body[] = [];
const db: { method: string; path: string; search: string; body: unknown }[] = [];
let nim: (body: Body) => Response = (body) => vectors(body);
let rpc: () => Response = () => Response.json(1);
const vault = new Map<string, Uint8Array>();

function vectors(body: Body): Response {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const modality = Array.isArray(body.modality) ? body.modality as string[] : [];
    return Response.json({ data: inputs.map((_, index) => ({ index, embedding: modality[index] === "image" ? IMAGE_VECTOR : TEXT_VECTOR })) });
}

globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "integrate.api.nvidia.com") {
        const body = JSON.parse(String(init?.body)) as Body;
        nimCalls.push(body);
        return nim(body);
    }
    if (url.hostname === "api.github.com") {
        const path = decodeURIComponent(url.pathname.replace("/repos/owner/vault/contents/", ""));
        const bytes = vault.get(path);
        return bytes ? Response.json({ content: Buffer.from(bytes).toString("base64"), sha: "f".repeat(40), type: "file", encoding: "base64" }) : new Response("{}", { status: 404 });
    }
    if (url.hostname === "photo-index.supabase.co") {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        db.push({ method, path: url.pathname, search: url.search, body });
        if (url.pathname.endsWith("/rpc/replace_knowledge_chunks")) return rpc();
        if (url.pathname.endsWith("/knowledge_documents") && method === "GET") {
            // `.single()` asks for one object: the lifecycle check reads a photo document that way.
            if (/vnd\.pgrst\.object/.test(new Headers(init?.headers).get("accept") ?? "")) {
                return Response.json({ id: "photo-doc", path: PHOTO, title: "Whiteboard", summary: "", category: "photos", status: "active", scope: "user", trust: "untrusted" });
            }
            return Response.json([{ id: "capture-note" }]);
        }
        if (url.pathname.endsWith("/model_call_observations")) return new Response(null, { status: 201 });
        return new Response(null, { status: method === "DELETE" ? 204 : 201 });
    }
    throw new Error(`Unexpected offline request to ${url.href}`);
};

const { NextRequest } = await import("next/server");
const { citedPhotoPaths, isImageAssetPath, photoMime, photoMarkdown, photoName, photoAssetUrl, MAX_SENT_PHOTOS } = await import("../src/lib/knowledge/photo-paths");
const { applyKnowledgeLifecycle } = await import("../src/lib/knowledge/lifecycle");
const { gitBlobSha, indexPhotoDocument, photoDocument, photoDocumentId, PHOTO_TEXT_MAX } = await import("../src/lib/knowledge/photos");
const { planPhotos, runPhotoIndex } = await import("../src/lib/knowledge/photo-sync");
const { photoAttachments, readSavedPhoto } = await import("../src/lib/knowledge/photo-files");
const { embedImagePassage, fuseVectors } = await import("../src/lib/ai/embeddings");
const { requestEmbeddings } = await import("../src/lib/ai/embedding-request");
const { migrationText } = await import("../src/lib/ai/embedding-migration");
const { resolveEmbedding } = await import("../src/lib/ai/providers");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const assetRoute = await import("../src/app/api/knowledge/asset/route");
const { createSessionValue } = await import("../src/lib/auth/session");
(await import("../src/lib/auth/session-epoch")).setSessionEpochSourceForTests(async () => null);
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;
type VaultEntry = import("../src/lib/vault/github").VaultEntry;

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    nimCalls.length = 0;
    db.length = 0;
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PHOTO = "attachments/captures/0c8a6f3e-1d2b-4c5d-8e9f-0a1b2c3d4e5f.jpg";

function embeddingRow(images: boolean): CatalogueRow {
    return {
        providerId: "nvidia-nim", modelId: "nvidia/nemotron-3.5-embed-1b", origin: "seed", label: "Nemotron 3.5 Embed 1B", shortName: "nemotron-3.5-embed-1b",
        description: null, developer: null, free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: ["text"],
        listedTools: null, listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 460,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null,
        firstSeenAt: "2026-11-24T00:00:00.000Z", lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: "2026-11-24T00:00:00.000Z", kind: "embedding", dimension: DIM, spaceOf: null, traits: { acceptsInputType: true, batch: true, images },
    };
}
function embedRef(images: boolean) {
    setCatalogueSnapshotForTests([embeddingRow(images)]);
    return resolveEmbedding("nvidia/nemotron-3.5-embed-1b", "nvidia-nim");
}

await check("photo paths: PNG and JPEG under attachments/ only, and names from the file", () => {
    for (const path of [PHOTO, "attachments/Trip 2026/beach.PNG", "attachments/scan.jpeg"]) assert.equal(isImageAssetPath(path), true, path);
    for (const path of ["notes/photo.jpg", "attachments/x.webp", "attachments/x.svg", "attachments/../notes/a.jpg", "attachments//a.jpg", "attachments/a.jpg.md", null, undefined, `attachments/${"a".repeat(320)}.jpg`]) {
        assert.equal(isImageAssetPath(path), false, String(path));
    }
    assert.equal(photoName("attachments/2026_trip-beach.jpg"), "2026 trip beach");
    assert.equal(photoAssetUrl("attachments/a b.jpg"), "/api/knowledge/asset?path=attachments%2Fa%20b.jpg");
    assert.equal(photoMime(JPEG), "image/jpeg"); assert.equal(photoMime(PNG), "image/png"); assert.equal(photoMime(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null);
});

await check("cited photos: only photo hits the reply names, once each, at most three", () => {
    const sources = [
        { kind: "photo", ref: "attachments/a.jpg" }, { kind: "vault", ref: "notes/a.md" }, { kind: "photo", ref: "attachments/b.png" },
        { kind: "photo", ref: "attachments/a.jpg" }, { kind: "photo", ref: "attachments/c.jpg" }, { kind: "photo", ref: "attachments/d.jpg" }, { kind: "photo", ref: "attachments/e.jpg" },
    ];
    assert.deepEqual(citedPhotoPaths("See attachments/b.png and notes/a.md.", sources), ["attachments/b.png"]);
    assert.deepEqual(citedPhotoPaths("attachments/a.jpg attachments/c.jpg attachments/d.jpg attachments/e.jpg", sources), ["attachments/a.jpg", "attachments/c.jpg", "attachments/d.jpg"]);
    assert.equal(MAX_SENT_PHOTOS, 3);
    assert.deepEqual(citedPhotoPaths("No citation here.", sources), []);
    assert.deepEqual(citedPhotoPaths("attachments/a.jpg", undefined), []);
    assert.deepEqual(citedPhotoPaths("notes/a.md", [{ kind: "vault", ref: "notes/a.md" }]), [], "pages are never sent as photos");
});

await check("photo document: a stable id, an untrusted photo, one image chunk whose text the switch job reproduces", () => {
    assert.equal(gitBlobSha(new TextEncoder().encode("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a", "git's own blob id for hello");
    const now = new Date("2026-11-24T05:00:00.000Z");
    const built = photoDocument({ path: PHOTO, title: "Whiteboard", text: "Platform 3 timetable.\r\nTrains every 10 minutes.", bytes: JPEG, sourcePath: "captures/whiteboard.md" }, now);
    assert.equal(built.document.id, photoDocumentId(PHOTO));
    assert.equal(photoDocumentId(PHOTO.toUpperCase().replace("ATTACHMENTS", "attachments")), built.document.id, "ids ignore case like page ids");
    assert.match(built.document.id, /^zuychin-photo-[0-9a-f]{24}$/);
    assert.equal(built.document.path, PHOTO);
    assert.deepEqual([built.document.category, built.document.kind, built.document.trust, built.document.status], ["photos", "document", "untrusted", "active"]);
    assert.equal(built.document.content_hash, gitBlobSha(JPEG));
    assert.deepEqual(built.document.provenance, [{ source: "captures/whiteboard.md", sourcePath: "captures/whiteboard.md", capturedAt: now.toISOString(), contentHash: gitBlobSha(JPEG) }]);
    assert.equal(built.chunk.content, "Platform 3 timetable.\nTrains every 10 minutes.");
    assert.deepEqual([built.chunk.modality, built.chunk.asset_path, built.chunk.ordinal, built.chunk.heading], ["image", PHOTO, 0, ""]);
    assert.match(built.chunk.id, new RegExp(`^${built.document.id}:0:[0-9a-f]{12}$`));
    const row = { id: built.chunk.id, content: built.chunk.content, heading_path: [], document: { title: built.document.title, path: PHOTO } };
    assert.equal(built.embedText, migrationText("knowledge_chunks", row));
    const bare = photoDocument({ path: "attachments/beach_day.png", text: "  ", bytes: PNG });
    assert.equal(bare.document.title, "beach day");
    assert.equal(bare.chunk.content, "Photo: beach day", "never an empty chunk, which the switch job refuses");
    assert.equal(photoDocument({ path: PHOTO, text: "x".repeat(PHOTO_TEXT_MAX + 50), bytes: JPEG }).chunk.content.length, PHOTO_TEXT_MAX);
    assert.throws(() => photoDocument({ path: "notes/a.jpg", text: "", bytes: JPEG }), /under attachments/);
});

await check("requests: images go as data URLs with one modality per input; Gemini routes and mismatched lists are refused", async () => {
    const sent: Body[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => { const body = JSON.parse(String(init?.body)) as Body; sent.push(body); return vectors(body); }) as typeof fetch;
    const route = { provider: { id: "nvidia-nim", kind: "openai-compatible" as const, baseUrl: "https://nim.invalid/v1" }, modelId: "vendor/embed", apiKey: "k", inputType: true };
    const result = await requestEmbeddings(route, ["data:image/png;base64,AAAA", "caption"], "passage", { fetchImpl, modalities: ["image", "text"] });
    assert.ok(result.ok);
    assert.deepEqual(sent[0], { model: "vendor/embed", input: ["data:image/png;base64,AAAA", "caption"], encoding_format: "float", input_type: "passage", modality: ["image", "text"] });
    await requestEmbeddings(route, ["data:image/png;base64,AAAA"], "passage", { fetchImpl, modalities: ["image"] });
    assert.deepEqual(sent[1].input, ["data:image/png;base64,AAAA"], "one image still goes as a list");
    await requestEmbeddings(route, ["plain"], "passage", { fetchImpl });
    assert.equal(sent[2].input, "plain"); assert.equal(sent[2].modality, undefined, "text requests are unchanged");
    await assert.rejects(requestEmbeddings(route, ["a", "b"], "passage", { fetchImpl, modalities: ["image"] }), /One modality is needed per input/);
    await assert.rejects(requestEmbeddings({ ...route, provider: { id: "gemini-free", kind: "gemini" as const } }, ["x"], "passage", { fetchImpl, modalities: ["image"] }), /OpenAI-shaped/);
});

await check("fused vectors: unit length, with the photo and its text weighing the same", () => {
    const fused = fuseVectors([3, 0, 0], [0, 0.5, 0]);
    assert.ok(Math.abs(Math.hypot(...fused) - 1) < 1e-9);
    assert.ok(Math.abs(fused[0] - fused[1]) < 1e-9);
    assert.throws(() => fuseVectors([1], [1, 2]), /same length/);
});

await check("photo embedding: the image and its text in one request when the model takes images, else the text alone", async () => {
    const image = { mimeType: "image/jpeg" as const, base64: Buffer.from(JPEG).toString("base64") };
    const withImages = await embedImagePassage(embedRef(true), { image, text: "Whiteboard\n\nPlatform 3" });
    assert.equal(withImages.withImage, true);
    assert.equal(nimCalls.length, 1);
    assert.deepEqual(nimCalls[0].modality, ["image", "text"]);
    assert.match((nimCalls[0].input as string[])[0], /^data:image\/jpeg;base64,\/9j\//);
    assert.equal((nimCalls[0].input as string[])[1], "Whiteboard\n\nPlatform 3");
    assert.ok(Math.abs(withImages.vector[1] - withImages.vector[2]) < 1e-9 && withImages.vector[1] > 0.7, "both halves weigh the same");
    nimCalls.length = 0;
    const textOnly = await embedImagePassage(embedRef(false), { image, text: "Whiteboard" });
    assert.equal(textOnly.withImage, false);
    assert.equal(nimCalls.length, 1); assert.equal(nimCalls[0].modality, undefined); assert.equal(nimCalls[0].input, "Whiteboard");
    assert.deepEqual(textOnly.vector, TEXT_VECTOR);
    await assert.rejects(embedImagePassage(embedRef(true), { image, text: "   " }), /needs text/);
});

await check("photo embedding: a refused pair is tried apart, a refused image keeps the text, an outage is an error", async () => {
    const image = { mimeType: "image/png" as const, base64: Buffer.from(PNG).toString("base64") };
    nim = (body) => Array.isArray(body.modality) && (body.modality as string[]).length === 2
        ? Response.json({ error: { message: "input rejected by content safety screening" } }, { status: 422 }) : vectors(body);
    const apart = await embedImagePassage(embedRef(true), { image, text: "Rent reminder" });
    assert.equal(apart.withImage, true);
    assert.deepEqual(nimCalls.map((call) => call.modality ?? "text"), [["image", "text"], "text", ["image"]]);
    nimCalls.length = 0;
    nim = (body) => Array.isArray(body.modality) ? Response.json({ error: { message: "Image could not be decoded" } }, { status: 400 }) : vectors(body);
    const words = await embedImagePassage(embedRef(true), { image, text: "Rent reminder" });
    assert.equal(words.withImage, false);
    assert.deepEqual(words.vector, TEXT_VECTOR);
    nim = () => Response.json({ error: { message: "busy" } }, { status: 503 });
    await assert.rejects(embedImagePassage(embedRef(true), { image, text: "Rent reminder" }), /503/);
    nim = (body) => vectors(body);
});

await check("indexing: the document, one image chunk with its vault path, and a link to the note", async () => {
    const result = await indexPhotoDocument({ path: PHOTO, title: "Whiteboard", text: "Platform 3", bytes: JPEG, sourcePath: "captures/whiteboard.md" }, embedRef(true));
    assert.deepEqual(result, { id: photoDocumentId(PHOTO), withImage: true });
    const upsert = db.find((call) => call.path.endsWith("/knowledge_documents") && call.method === "POST")!;
    assert.match(upsert.search, /on_conflict=id/);
    assert.equal((upsert.body as { path: string }).path, PHOTO);
    const chunks = (db.find((call) => call.path.endsWith("/rpc/replace_knowledge_chunks"))!.body as { p_document_id: string; p_chunks: Body[] });
    assert.equal(chunks.p_document_id, photoDocumentId(PHOTO));
    assert.equal(chunks.p_chunks.length, 1);
    assert.deepEqual([chunks.p_chunks[0].modality, chunks.p_chunks[0].asset_path, chunks.p_chunks[0].embedding_model], ["image", PHOTO, "nvidia/nemotron-3.5-embed-1b"]);
    assert.equal((chunks.p_chunks[0].embedding as number[]).length, DIM);
    assert.ok(db.some((call) => call.method === "DELETE" && call.path.endsWith("/knowledge_links")), "old links are cleared");
    const link = db.find((call) => call.method === "POST" && call.path.endsWith("/knowledge_links"))!.body as Body;
    assert.deepEqual(link, { source_document_id: photoDocumentId(PHOTO), target_document_id: "capture-note", target_ref: "captures/whiteboard.md", relation: "related" });
    db.length = 0;
    await indexPhotoDocument({ path: "attachments/b.png", text: "", bytes: PNG }, embedRef(false));
    assert.ok(!db.some((call) => call.method === "POST" && call.path.endsWith("/knowledge_links")), "no note, no link");
    rpc = () => Response.json({ code: "PGRST202", message: "Could not find the function public.replace_knowledge_chunks" }, { status: 404 });
    assert.equal(await indexPhotoDocument({ path: PHOTO, text: "x", bytes: JPEG }, embedRef(true)), null, "no knowledge tables yet");
    rpc = () => Response.json(1);
    await assert.rejects(indexPhotoDocument({ path: PHOTO, text: "x", bytes: new Uint8Array([1, 2, 3, 4, 5]) }, embedRef(true)), /PNG and JPEG/);
    const large = new Uint8Array(2 * 1024 * 1024 + 1); large.set(JPEG);
    await assert.rejects(indexPhotoDocument({ path: PHOTO, text: "x", bytes: large }, embedRef(true)), /over 2 MB/);
});

const entry = (path: string, sha: string, size = 1000): VaultEntry => ({ path, name: path.split("/").pop()!, type: "file", sha, size });

await check("vault photos: new and changed photos are planned, unchanged ones skipped, removed ones retired, large ones counted", () => {
    const files = [entry("attachments/new.jpg", "a1"), entry("attachments/same.png", "b2"), entry("attachments/changed.jpg", "c3"), entry("attachments/huge.jpg", "d4", 3 * 1024 * 1024),
        entry("attachments/diagram.svg", "e5"), entry("notes/page.md", "f6"), entry("attachments/restored.jpg", "g7")];
    const rows = [
        { id: "p1", path: "attachments/same.png", content_hash: "b2", status: "active" }, { id: "p2", path: "attachments/changed.jpg", content_hash: "old", status: "active" },
        { id: "p3", path: "attachments/gone.jpg", content_hash: "x", status: "active" }, { id: "p4", path: "attachments/restored.jpg", content_hash: "g7", status: "deleted" },
        { id: "p5", path: "attachments/long-gone.jpg", content_hash: "y", status: "deleted" },
    ];
    const plan = planPhotos(files, rows);
    assert.deepEqual(plan.pending.map((file) => file.path), ["attachments/new.jpg", "attachments/changed.jpg", "attachments/restored.jpg"]);
    assert.deepEqual(plan.tooLarge, ["attachments/huge.jpg"]);
    assert.deepEqual(plan.gone.map((row) => row.id), ["p3"]);
    assert.equal(plan.indexed, 1);
});

await check("vault photo run: each photo is described then indexed, failures are kept, the limit holds", async () => {
    const files = [entry("attachments/a.jpg", "1"), entry("attachments/b.png", "2"), entry("attachments/c.jpg", "3"), entry("attachments/d.jpg", "4")];
    const bytes: Record<string, Uint8Array | null> = { "attachments/a.jpg": JPEG, "attachments/b.png": new Uint8Array([1, 2, 3, 4, 5]), "attachments/c.jpg": null, "attachments/d.jpg": JPEG };
    const described: string[] = [], indexed: { path: string; title?: string; text: string }[] = [], retired: string[][] = [];
    const result = await runPhotoIndex({
        listFiles: async () => files,
        indexedPhotos: async () => [{ id: "old", path: "attachments/removed.jpg", content_hash: "z", status: "active" }],
        readFile: async (path) => bytes[path],
        describe: async (_bytes, mimeType) => { described.push(mimeType); return "A red bicycle by a fence."; },
        index: async (input) => { indexed.push({ path: input.path, title: input.title, text: input.text }); return { withImage: true }; },
        retire: async (rows) => { retired.push(rows.map((row) => row.id)); },
    }, 3);
    assert.deepEqual(result.indexed, ["attachments/a.jpg"]);
    assert.deepEqual(result.failed.map((failure) => failure.path), ["attachments/b.png", "attachments/c.jpg"]);
    assert.match(result.failed[0].error, /not a PNG or JPEG/); assert.match(result.failed[1].error, /no longer in the vault/);
    assert.deepEqual(indexed, [{ path: "attachments/a.jpg", title: "a", text: "A red bicycle by a fence." }]);
    assert.deepEqual(described, ["image/jpeg"]);
    assert.deepEqual(retired, [["old"]]);
    assert.equal(result.withImage, 1);
    assert.equal(result.left, 3, "d.jpg waits for the next run; the two failures stay pending");
});

await check("SQL: the chunk writer stores a photo's modality and vault path, and text chunks keep the defaults", async () => {
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    const migration = await readFile(new URL("./migrations/v8-media.sql", import.meta.url), "utf8");
    const sql = new PGlite();
    try {
        // No pgvector in PGlite; a text domain stands in for the vector cast.
        await sql.exec("create domain vector as text;");
        for (const table of ["knowledge_documents", "knowledge_chunks"]) {
            const match = setup.match(new RegExp(String.raw`create table if not exists ${table} \([\s\S]*?\n\);`));
            assert.ok(match, `${table} is in the setup`);
            await sql.exec(match[0].replace(/\s*user_profile_id uuid references user_profiles\(id\) on delete set null,|\s*project_id uuid references projects\(id\) on delete set null,/g, ""));
        }
        const start = migration.indexOf("-- Image rows in the knowledge store");
        await sql.exec(migration.slice(start, migration.indexOf("notify pgrst")));
        await sql.query("insert into knowledge_documents (id, path, title, content_hash) values ('doc', $1, 'Whiteboard', 'h')", [PHOTO]);
        const chunk = (id: string, ordinal: number, extra: Body = {}) => ({ id, heading: "", heading_path: [], ordinal, content: `c${ordinal}`, content_hash: "h", token_count: 1, embedding: "[1,0]", embedding_model: "m", ...extra });
        const written = await sql.query<{ count: number }>("select replace_knowledge_chunks('doc', $1::jsonb) as count", [JSON.stringify([chunk("a", 0, { modality: "image", asset_path: PHOTO }), chunk("b", 1)])]);
        assert.equal(written.rows[0].count, 2);
        const rows = (await sql.query<{ id: string; modality: string; asset_path: string | null }>("select id, modality, asset_path from knowledge_chunks order by ordinal")).rows;
        assert.deepEqual(rows, [{ id: "a", modality: "image", asset_path: PHOTO }, { id: "b", modality: "text", asset_path: null }]);
        await assert.rejects(sql.query("select replace_knowledge_chunks('doc', $1::jsonb)", [JSON.stringify([chunk("c", 0, { modality: "image", asset_path: "notes/secret.md" })])]), /check/i);
        assert.equal((await sql.query<{ n: number }>("select count(*)::int as n from knowledge_chunks")).rows[0].n, 2, "a refused write keeps the old chunks");
    } finally {
        await sql.close();
    }
});

await check("Knowledge page: a photo document reads as the photo and its text, and no lifecycle action writes over the image", async () => {
    assert.equal(photoMarkdown("Whiteboard [draft]", PHOTO, ["Platform 3", "  ", "Trains every 10 minutes."]),
        `![Whiteboard  draft](${photoAssetUrl(PHOTO)})\n\nPlatform 3\n\nTrains every 10 minutes.\n`);
    assert.equal(photoMarkdown("", "attachments/a.png", []), `![Photo](${photoAssetUrl("attachments/a.png")})\n`);
    await assert.rejects(applyKnowledgeLifecycle({ action: "archive", documentId: "photo-doc" }), /photo is changed in the vault itself/);
    assert.ok(!db.some((call) => call.method !== "GET"), "nothing was written");
});

const session = `${AUTH_COOKIE}=${await createSessionValue()}`;
const asset = (path: string, cookie = session) => assetRoute.GET(new NextRequest(`https://assistant.test/api/knowledge/asset?path=${encodeURIComponent(path)}`, { headers: { cookie } }));

await check("photo route: a session, a PNG or JPEG under attachments/, served inline with nosniff", async () => {
    vault.set(PHOTO, JPEG);
    vault.set("attachments/fake.png", new TextEncoder().encode("<svg onload=alert(1)>"));
    assert.equal((await asset(PHOTO, "")).status, 401);
    const ok = await asset(PHOTO);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.match(ok.headers.get("content-disposition")!, /^inline; filename="0c8a6f3e-1d2b-4c5d-8e9f-0a1b2c3d4e5f\.jpg"$/);
    assert.match(ok.headers.get("cache-control")!, /^private/);
    assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), JPEG);
    assert.equal((await asset("notes/page.md")).status, 400);
    assert.equal((await asset("attachments/x.svg")).status, 400);
    assert.equal((await asset("attachments/missing.jpg")).status, 404);
    assert.equal((await asset("attachments/fake.png")).status, 415, "bytes decide, not the extension");
});

await check("channels: cited photos load from the vault for Telegram and as Discord artifacts; missing ones are skipped", async () => {
    vault.set("attachments/b.png", PNG);
    const photo = await readSavedPhoto(PHOTO);
    assert.deepEqual(photo && { name: photo.name, mimeType: photo.mimeType }, { name: "0c8a6f3e-1d2b-4c5d-8e9f-0a1b2c3d4e5f.jpg", mimeType: "image/jpeg" });
    assert.equal(await readSavedPhoto("notes/page.md"), null);
    assert.equal(await readSavedPhoto("attachments/fake.png"), null);
    const artifacts = await photoAttachments([PHOTO, "attachments/missing.jpg", "attachments/b.png"]);
    assert.deepEqual(artifacts.map((artifact) => [artifact.id, artifact.name, artifact.mime]), [["photo-1", "0c8a6f3e-1d2b-4c5d-8e9f-0a1b2c3d4e5f.jpg", "image/jpeg"], ["photo-3", "b.png", "image/png"]]);
    assert.equal(artifacts[0].base64, Buffer.from(JPEG).toString("base64"));
    assert.deepEqual(await photoAttachments(undefined), []);
});

setCatalogueSnapshotForTests([]);
console.log(`${checks} photo search checks passed`);
