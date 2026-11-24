// Offline checks for V8 F2: photos and scanned pages in Capture, the page reader, vault storage of the photo, and the
// Android share target. Every request goes to a fake fetch.
import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://photo-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat", AUTH_ORIGIN: "https://assistant.test", NVIDIA_NIM_API_KEY: "fixture-nim",
});
delete process.env.MEDIA_KINDS;

const profile = "11111111-1111-4111-8111-111111111111";
const seen: { url: URL; method: string }[] = [];
let parseReply: () => Response = () => Response.json({ content: "" });
// A failed parse moves on to the caption model, which answers with an error here.
const chatReply = () => Response.json({ error: { message: "no chat in this check" } }, { status: 500 });
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    seen.push({ url, method });
    if (url.hostname === "photo-fixture.supabase.co") {
        if (url.pathname.endsWith("/user_profiles")) return Response.json({ id: profile, preferences: {} });
        if (url.pathname.endsWith("/model_call_observations")) return new Response(null, { status: 201 });
        throw new Error(`Unexpected database request to ${url.pathname}`);
    }
    if (url.hostname === "ai.api.nvidia.com") return parseReply();
    if (url.hostname === "integrate.api.nvidia.com") return chatReply();
    throw new Error(`Unexpected offline request to ${url.href}`);
};

const { NextRequest } = await import("next/server");
const { readPageImage, pageImageMime, MIN_PARSED_CHARS } = await import("../src/lib/capture/extract/page-image");
const { extractCapture, ocrCapture, photoDraft } = await import("../src/lib/capture/extract");
const { createCaptureService, validateCaptureSource, originalAssetPath, MAX_CAPTURE_IMAGE_BYTES } = await import("../src/lib/capture/service");
const { sourceStatus, offersGemini, offersPageReading, pageSection, readableCapture, KIND_LABEL, PAGE_READ_LIMIT } = await import("../src/lib/capture/review-source");
const { readShareForm, sharedFileType, stageShare, stagedShare, STAGED_TTL_MS } = await import("../src/lib/capture/staged-share");
const { bodyLimit, NEXT_BODY_LIMIT, PAGE_IMAGE_BODY_LIMIT, SHARE_BODY_LIMIT } = await import("../src/lib/http/limits");
const { jpegName, photoTitle, scaledSize } = await import("../src/lib/capture/image-prep");
const manifest = (await import("../src/app/manifest")).default;
const { proxy } = await import("../src/proxy");
const shareRoute = await import("../src/app/capture/share/route");
const stagedRoute = await import("../src/app/api/capture/staged/route");
const parsePageRoute = await import("../src/app/api/capture/parse-page/route");
const { createSessionValue } = await import("../src/lib/auth/session");
(await import("../src/lib/auth/session-epoch")).setSessionEpochSourceForTests(async () => null);
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { setMediaChoicesForTests } = await import("../src/lib/ai/media/choices");
import type { CatalogueRow } from "../src/lib/ai/catalogue/snapshot";
import type { CaptureExtract, CaptureItem } from "../src/lib/capture/types";
import type { PageReader } from "../src/lib/capture/extract/page-image";

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypheic"), 0, 0, 0, 0]);
const PDF = new Uint8Array(Buffer.from("%PDF-1.7\nfixture"));
const jpegBase64 = Buffer.from(JPEG).toString("base64");
const tagged = (text: string, kind = "Text") => `<x_0.1><y_0.1>${text}<x_0.9><y_0.12><class_${kind}>`;
const INVOICE = "Invoice 1042: the rent of $450 is due on 1 December 2026.";
const reader = (label: string, result: string | Error): PageReader => ({ label, read: async () => { if (result instanceof Error) throw result; return result; } });
const deps = (parser: PageReader | null, captioner: PageReader | null) => ({ parser: async () => parser, captioner: async () => captioner });
const page = { bytes: PNG, mimeType: "image/png" as const };

await check("page reader: parsed text, a caption when there is little text, and every fallback", async () => {
    assert.ok(INVOICE.length >= MIN_PARSED_CHARS);
    assert.deepEqual(await readPageImage(page, { freeOnly: false, deps: deps(reader("Parse", tagged(INVOICE)), reader("Vision", "unused")) }),
        { method: "parse", markdown: INVOICE, model: "Parse" });
    assert.deepEqual(await readPageImage(page, { freeOnly: false, deps: deps(reader("Parse", tagged("EXIT")), reader("Vision", "A green exit sign above a door.")) }),
        { method: "caption", markdown: "A green exit sign above a door.\n\nEXIT", model: "Vision" });
    assert.deepEqual(await readPageImage(page, { freeOnly: false, deps: deps(reader("Parse", tagged("EXIT")), null) }), { method: "parse", markdown: "EXIT", model: "Parse" });
    assert.deepEqual(await readPageImage(page, { freeOnly: false, deps: deps(reader("Parse", new Error("HTTP 503")), reader("Vision", "A beach at sunset.")) }),
        { method: "caption", markdown: "A beach at sunset.", model: "Vision" });
    assert.deepEqual(await readPageImage(page, { freeOnly: false, deps: deps(reader("Parse", new Error("HTTP 503")), reader("Vision", new Error("timed out"))) }),
        { method: "none", markdown: "", model: null, failures: ["Parse: HTTP 503", "Vision: timed out"] });
    assert.deepEqual(await readPageImage(page, { freeOnly: true, deps: deps(null, null) }), { method: "none", markdown: "", model: null, failures: [] });
    let askedFreeOnly: boolean | null = null;
    await readPageImage(page, { freeOnly: true, deps: { parser: async (freeOnly) => { askedFreeOnly = freeOnly; return null; }, captioner: async () => null } });
    assert.equal(askedFreeOnly, true, "Free only reaches the model pick");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readPageImage(page, { freeOnly: false, signal: controller.signal, deps: deps(reader("Parse", new Error("aborted")), reader("Vision", "never")) }), /aborted/);
});

await check("page images: PNG and JPEG only, sniffed from the bytes", () => {
    assert.equal(pageImageMime(PNG), "image/png");
    assert.equal(pageImageMime(JPEG), "image/jpeg");
    for (const bytes of [WEBP, HEIC, PDF, new Uint8Array([1, 2, 3])]) assert.equal(pageImageMime(bytes), null);
});

await check("photo extracts: parsed, described, empty, failed and not set up", async () => {
    const now = () => new Date("2026-11-24T01:00:00.000Z");
    const source = { kind: "image" as const, title: "Receipt", text: "", image: { name: "receipt.jpg", base64: jpegBase64 } };
    let asked: { mimeType: string; freeOnly: boolean } | null = null;
    const parsed = await extractCapture(source, { now, freeOnly: false, readImage: async (image, options) => {
        asked = { mimeType: image.mimeType, freeOnly: options.freeOnly };
        return { method: "parse", markdown: INVOICE, model: "Nemotron 3.5 Parse (free)" };
    } });
    assert.deepEqual(asked, { mimeType: "image/jpeg", freeOnly: false });
    assert.equal(parsed.status, "ok"); assert.equal(parsed.method, "parse"); assert.equal(parsed.model, "Nemotron 3.5 Parse (free)");
    assert.equal(parsed.words, 12); assert.equal(parsed.fetchedAt, "2026-11-24T01:00:00.000Z");
    assert.deepEqual(photoDraft({ method: "caption", markdown: "A red umbrella on a wet street.", model: "GLM-5.3 Flash (free)" }),
        { method: "caption", status: "ok", text: "A red umbrella on a wet street.", model: "GLM-5.3 Flash (free)" });
    assert.equal(photoDraft({ method: "parse", markdown: "", model: "Parse" }).status, "empty");
    assert.match(photoDraft({ method: "none", markdown: "", model: null, failures: ["Parse: HTTP 503"] }).note!, /could not be read\. Parse: HTTP 503/);
    const unset = photoDraft({ method: "none", markdown: "", model: null, failures: [] });
    assert.equal(unset.status, "empty"); assert.match(unset.note!, /Read it with Gemini/);
    await assert.rejects(extractCapture({ ...source, image: undefined }), /no photo/);
});

await check("Gemini reads a photo as a JPEG image", async () => {
    let mime = "";
    const read = await ocrCapture({ kind: "image", title: "Sign", text: "", image: { name: "sign.jpg", base64: jpegBase64 } }, null, "free", {
        freeOnly: false, generate: async (_bytes, tier, mimeType) => { mime = mimeType; assert.equal(tier, "free"); return { text: "Platform 3" }; },
    });
    assert.equal(mime, "image/jpeg");
    assert.equal(read.method, "ocr-free"); assert.equal(read.status, "ok"); assert.equal(read.text, "Platform 3"); assert.equal(read.contentType, "image/jpeg");
    const blank = await ocrCapture({ kind: "image", title: "Wall", text: "", image: { name: "wall.jpg", base64: jpegBase64 } }, null, "free", { freeOnly: false, generate: async () => ({ text: "[no text]" }) });
    assert.equal(blank.status, "empty"); assert.match(blank.note!, /no readable text in the photo/);
});

await check("validation: JPEG photos up to 2 MB, and only on photo captures", () => {
    const photo = validateCaptureSource({ kind: "image", title: "Whiteboard", text: "", image: { name: "white/board\u0001.jpg", base64: jpegBase64 } });
    assert.equal(photo.image?.name, "white_board_.jpg");
    assert.throws(() => validateCaptureSource({ kind: "image", title: "PNG", text: "", image: { name: "a.png", base64: Buffer.from(PNG).toString("base64") } }), /JPEG/);
    const big = Buffer.alloc(MAX_CAPTURE_IMAGE_BYTES + 1); big.set(JPEG);
    assert.throws(() => validateCaptureSource({ kind: "image", title: "Big", text: "", image: { name: "big.jpg", base64: big.toString("base64") } }), /2 MB|Check|too_big|String/i);
    assert.throws(() => validateCaptureSource({ kind: "image", title: "None", text: "" }), /valid photo/);
    assert.throws(() => validateCaptureSource({ kind: "text", title: "Note", text: "Words", image: { name: "a.jpg", base64: jpegBase64 } }), /Only photo captures/);
    assert.equal(originalAssetPath("abc", { image: { name: "a.jpg", base64: "" } }), "attachments/captures/abc.jpg");
    assert.equal(originalAssetPath("abc", { pdf: { name: "a.pdf", base64: "" } }), "attachments/captures/abc.pdf");
    assert.equal(originalAssetPath("abc", {}), null);
});

const id = "22222222-2222-4222-8222-222222222222", pdfId = "33333333-3333-4333-8333-333333333333";
const rows = new Map<string, CaptureItem>(), files = new Map<string, string>(), saved: CaptureExtract[] = [];
const committed: { path: string; content?: string; contentBase64?: string }[][] = [];
let head = "a".repeat(40), readProfile = "";
const photosIndexed: Record<string, string>[] = [];
const service = createCaptureService({
    get: async (owner, key) => rows.get(`${owner}:${key}`) ?? null,
    insert: async (item) => { const key = `${item.profileId}:${item.id}`; if (!rows.has(key)) rows.set(key, item); return rows.get(key)!; },
    receipt: async (owner, key, receipt) => { rows.get(`${owner}:${key}`)!.receipt = receipt; },
    claim: async (_owner, _key, claim) => claim,
    head: async () => head, read: async (path) => files.get(path) ?? null,
    commit: async (changes) => { committed.push(changes); changes.forEach(change => files.set(change.path, change.content ?? change.contentBase64!)); head = "b".repeat(40); return { commit: head }; },
    index: async () => {},
    indexPhoto: async (photo, owner) => { photosIndexed.push({ ...photo, owner }); },
    saveExtract: async (owner, key, extract) => { saved.push(extract); rows.get(`${owner}:${key}`)!.extract = extract; },
    extractor: {
        read: async (_source, owner) => { readProfile = owner; return { version: 1, status: "ok", method: "parse", text: INVOICE, truncated: false, words: 11, fetchedAt: "2026-11-24T01:00:00.000Z", model: "Parse" }; },
        ocr: async () => ({ version: 1, status: "ok", method: "ocr-free", text: "Platform 3", truncated: false, words: 2, fetchedAt: "2026-11-24T01:00:00.000Z" }),
        ocrTiers: async () => ({ free: true, paid: false }),
        acquire: () => () => {},
        now: () => new Date("2026-11-24T02:00:00.000Z"),
    },
});

await check("service: a photo is read with the owner's profile, previewed with its original, and committed beside the note", async () => {
    await service.capture(profile, id, { kind: "image", title: "Whiteboard", text: "From Monday's meeting.", image: { name: "board.jpg", base64: jpegBase64 } });
    const read = await service.extract(profile, id);
    assert.equal(readProfile, profile); assert.equal(read.extract.method, "parse");
    const preview = await service.preview(profile, id, { title: "Whiteboard", text: "From Monday's meeting.", destination: "captures/whiteboard.md", sourceText: INVOICE });
    assert.equal(preview.originalPath, `attachments/captures/${id}.jpg`);
    assert.match(preview.markdown, new RegExp(`original_asset: attachments/captures/${id}\\.jpg`));
    assert.match(preview.markdown, new RegExp(`\\[Original photo\\]\\(/api/capture/original\\?id=${id}\\)`));
    assert.match(preview.markdown, /extracted_by: page-reader/);
    await service.ingest(profile, preview);
    assert.deepEqual(committed.at(-1)!.map(change => change.path), ["captures/whiteboard.md", `attachments/captures/${id}.jpg`]);
    assert.equal(committed.at(-1)![1].contentBase64, jpegBase64);
    const running = await service.extract(profile, "44444444-4444-4444-8444-444444444444").catch((error: Error) => error.message);
    assert.match(String(running), /not found/);
});

await check("service: a kept photo is indexed for photo search after its note, with the reviewed text; a PDF is not", async () => {
    const keptId = "66666666-6666-4666-8666-666666666666", keptPdf = "77777777-7777-4777-8777-777777777777";
    await service.capture(profile, keptId, { kind: "image", title: "Receipt", text: "Coffee with a friend.", image: { name: "receipt.jpg", base64: jpegBase64 } });
    await service.extract(profile, keptId);
    const preview = await service.preview(profile, keptId, { title: "Receipt", text: "Coffee with a friend.", destination: "captures/receipt.md", sourceText: INVOICE });
    const result = await service.ingest(profile, preview);
    assert.equal(photosIndexed.length, 0, "indexing waits for the background step");
    await result.background!();
    assert.deepEqual(photosIndexed, [{ path: `attachments/captures/${keptId}.jpg`, notePath: "captures/receipt.md", title: "Receipt",
        base64: jpegBase64, text: `${INVOICE}\n\nCoffee with a friend.`, owner: profile }]);
    await service.capture(profile, keptPdf, { kind: "pdf", title: "Lease", text: "Signed copy.", pdf: { name: "lease.pdf", base64: Buffer.from(PDF).toString("base64") } });
    const pdfResult = await service.ingest(profile, await service.preview(profile, keptPdf, { title: "Lease", text: "Signed copy.", destination: "captures/lease.md" }));
    await pdfResult.background!();
    assert.equal(photosIndexed.length, 1, "a PDF original is not a photo");
});

await check("service: Gemini may read a photo that is not yet in knowledge", async () => {
    const photoId = "55555555-5555-4555-8555-555555555555";
    await service.capture(profile, photoId, { kind: "image", title: "Sign", text: "", image: { name: "sign.jpg", base64: jpegBase64 } });
    const result = await service.extract(profile, photoId, { ocr: "free" });
    assert.equal(result.extract.status, "running"); assert.ok(result.background);
    await result.background!();
    assert.equal(rows.get(`${profile}:${photoId}`)!.extract?.text, "Platform 3");
});

await check("service: text read page by page is saved for PDF captures only, within the page limit", async () => {
    await service.capture(profile, pdfId, { kind: "pdf", title: "Scan", text: "", pdf: { name: "scan.pdf", base64: Buffer.from(PDF).toString("base64") } });
    const text = `### Page 1\n\n${INVOICE}\n\n### Page 2\n\n[This page could not be read.]`;
    const extract = await service.savePages(profile, pdfId, { text, pages: 2, unread: 1, model: "Nemotron 3.5 Parse (free)" });
    assert.equal(extract.status, "ok"); assert.equal(extract.method, "parse"); assert.equal(extract.pages, 2); assert.equal(extract.contentType, "application/pdf");
    assert.equal(extract.note, "1 of 2 pages could not be read."); assert.equal(extract.fetchedAt, "2026-11-24T02:00:00.000Z");
    assert.equal(saved.at(-1), extract);
    assert.equal((await service.savePages(profile, pdfId, { text: "  ", pages: 1, unread: 0, model: "Parse" })).status, "empty");
    await assert.rejects(service.savePages(profile, pdfId, { text, pages: 2, unread: 3, model: "Parse" }), /page counts/);
    await assert.rejects(service.savePages(profile, pdfId, { text, pages: PAGE_READ_LIMIT + 1, unread: 0, model: "Parse" }));
    await assert.rejects(service.savePages(profile, pdfId, { text, pages: 1, unread: 0, model: "Parse", extra: true }));
    await assert.rejects(service.savePages(profile, id, { text, pages: 1, unread: 0, model: "Parse" }), /already in knowledge/);
    const photoId = "55555555-5555-4555-8555-555555555555";
    await assert.rejects(service.savePages(profile, photoId, { text, pages: 1, unread: 0, model: "Parse" }), /Only PDF captures/);
    rows.get(`${profile}:${pdfId}`)!.extract = { ...extract, status: "running" };
    await assert.rejects(service.savePages(profile, pdfId, { text, pages: 1, unread: 0, model: "Parse" }), /Gemini is reading/);
});

await check("review: photo and page-reader wording, and which captures offer Gemini or Read pages", () => {
    const item = (kind: "image" | "pdf" | "link"): CaptureItem => ({ id, profileId: profile, sourceHash: "x", createdAt: "", receipt: null,
        source: { kind, title: "T", text: "", ...(kind === "link" ? { url: "https://example.com/a.pdf" } : {}) } });
    const at = "2026-11-24T02:00:00.000Z";
    const base = { version: 1 as const, truncated: false, fetchedAt: at };
    const photo = item("image"), pdf = item("pdf"), link = item("link");
    assert.ok(readableCapture(photo)); assert.equal(KIND_LABEL.image, "photo"); assert.equal(KIND_LABEL.offline_note, "offline note");
    assert.equal(sourceStatus(photo, undefined, "read"), "Reading the photo…");
    assert.equal(sourceStatus(photo, undefined, ""), "The photo has not been read yet.");
    assert.equal(sourceStatus(pdf, undefined, "pages"), "Reading the pages…");
    const parsed: CaptureExtract = { ...base, status: "ok", method: "parse", text: INVOICE, words: 11, model: "Nemotron 3.5 Parse (free)" };
    assert.equal(sourceStatus(photo, parsed, ""), "Nemotron 3.5 Parse (free) read 11 words from the photo on 24/11/2026.");
    assert.equal(sourceStatus(pdf, { ...parsed, pages: 3, note: "1 of 3 pages could not be read." }, ""),
        "Nemotron 3.5 Parse (free) read 11 words from the PDF (3 pages) on 24/11/2026. 1 of 3 pages could not be read.");
    const caption: CaptureExtract = { ...base, status: "ok", method: "caption", text: "A beach.", words: 2, model: "GLM-5.3 Flash (free)" };
    assert.equal(sourceStatus(photo, caption, ""), "No text was found, so GLM-5.3 Flash (free) described the photo on 24/11/2026.");
    assert.equal(sourceStatus(photo, { ...base, status: "running", method: "ocr-free", text: "", words: 0 }, ""), "Gemini is reading the photo…");
    assert.equal(offersGemini(photo, caption), true, "a description is not the photo's text");
    assert.equal(offersGemini(photo, parsed), false);
    assert.equal(offersGemini(photo, { ...parsed, status: "empty" }), true);
    const scanned: CaptureExtract = { ...base, status: "scanned", method: "pdf-text", text: "", words: 0, contentType: "application/pdf" };
    assert.equal(offersPageReading(pdf, scanned), true);
    assert.equal(offersPageReading(link, scanned), false, "a linked PDF is not stored, so only Gemini can read it");
    assert.equal(offersGemini(link, scanned), true);
    assert.equal(offersPageReading(pdf, { ...parsed, contentType: "application/pdf", status: "empty" }), true, "an empty page read can be tried again");
    assert.equal(offersPageReading(pdf, { ...parsed, contentType: "application/pdf" }), false);
    assert.equal(pageSection(2, "### Rent reminder\n\n```\n# not a heading\n```\n\n#### Due"), "### Page 2\n\n#### Rent reminder\n\n```\n# not a heading\n```\n\n##### Due");
    assert.equal(pageSection(3, null), "### Page 3\n\n[This page could not be read.]");
});

await check("staged shares: the first photo or PDF is kept by its bytes, entries expire, and at most three wait", async () => {
    assert.equal(sharedFileType(JPEG), "image/jpeg"); assert.equal(sharedFileType(WEBP), "image/webp"); assert.equal(sharedFileType(HEIC), "image/heic");
    assert.equal(sharedFileType(PDF), "application/pdf"); assert.equal(sharedFileType(new Uint8Array(Buffer.from("MZ executable"))), null);
    const form = new FormData();
    form.append("title", " Holiday "); form.append("text", "Look at this");
    form.append("files", new Blob([new Uint8Array(Buffer.from("not an image"))], { type: "image/jpeg" }), "fake.jpg");
    form.append("files", new Blob([PNG], { type: "application/octet-stream" }), "sea/side.png");
    form.append("files", new Blob([JPEG], { type: "image/jpeg" }), "second.jpg");
    const shared = await readShareForm(form);
    assert.equal(shared?.title, "Holiday"); assert.equal(shared?.text, "Look at this"); assert.equal(shared?.skipped, 2);
    assert.deepEqual({ name: shared?.file?.name, type: shared?.file?.type }, { name: "sea_side.png", type: "image/png" });
    assert.equal(await readShareForm(new FormData()), null);
    const only = new FormData(); only.append("files", new Blob([new Uint8Array([1, 2, 3])]), "notes.docx");
    assert.deepEqual(await readShareForm(only), { title: "", text: "", url: "", file: null, skipped: 1 });
    const start = 1_000_000;
    const first = stageShare(shared!, start);
    assert.equal(stagedShare(first, start + 1000)?.title, "Holiday");
    assert.equal(stagedShare(first, start + STAGED_TTL_MS + 1), null, "expired");
    const ids = [0, 1, 2, 3].map(step => stageShare({ ...shared!, title: `share ${step}` }, start + STAGED_TTL_MS * 3 + step));
    assert.equal(stagedShare(ids[0], start + STAGED_TTL_MS * 3 + 10), null, "the oldest of four is dropped");
    assert.equal(stagedShare(ids[3], start + STAGED_TTL_MS * 3 + 10)?.title, "share 3");
});

await check("limits, the manifest's share target and the image helpers", () => {
    assert.equal(bodyLimit("/api/capture/parse-page"), PAGE_IMAGE_BODY_LIMIT);
    assert.equal(PAGE_IMAGE_BODY_LIMIT, 2 * 1024 * 1024);
    assert.equal(bodyLimit("/capture/share"), SHARE_BODY_LIMIT);
    assert.ok(SHARE_BODY_LIMIT < NEXT_BODY_LIMIT, "a share Next cut short is always over the limit");
    assert.equal(bodyLimit("/api/capture"), 3_000_000);
    const share = manifest().share_target!;
    assert.equal(share.action, "/capture/share"); assert.equal(share.method, "POST"); assert.equal(share.enctype, "multipart/form-data");
    assert.deepEqual({ title: share.params.title, text: share.params.text, url: share.params.url }, { title: "title", text: "text", url: "url" });
    assert.deepEqual(share.params.files, [{ name: "files", accept: ["image/*", "application/pdf"] }]);
    assert.deepEqual(scaledSize(4032, 3024, 1600), { width: 1600, height: 1200 });
    assert.deepEqual(scaledSize(3024, 4032, 1600), { width: 1200, height: 1600 });
    assert.deepEqual(scaledSize(800, 600, 1600), { width: 800, height: 600 }, "never enlarged");
    assert.equal(jpegName("IMG_2041.HEIC"), "IMG_2041.jpg"); assert.equal(jpegName(".png"), "photo.jpg");
    assert.equal(photoTitle("bus_timetable-2026.png"), "bus timetable 2026"); assert.equal(photoTitle(".jpg"), "Photo");
});

const ownerSession = await createSessionValue();
const cookie = `${AUTH_COOKIE}=${ownerSession}`;
const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

await check("proxy: the share sheet may post with Origin null; other cookie writes may not", async () => {
    const post = (path: string, origin: string) => proxy(new NextRequest(`https://assistant.test${path}`, { method: "POST", headers: { origin, cookie } }));
    assert.ok(passedThrough(await post("/capture/share", "null")));
    assert.equal((await post("/capture/share", "https://evil.test")).status, 403);
    assert.equal((await post("/api/capture", "null")).status, 403);
    assert.equal((await post("/api/capture/parse-page", "null")).status, 403);
    const signedOut = await proxy(new NextRequest("https://assistant.test/capture/share", { method: "POST", headers: { origin: "null" } }));
    assert.equal(new URL(signedOut.headers.get("location")!).pathname, "/login");
    for (const [path, method] of [["/api/capture/parse-page", "POST"], ["/api/capture/staged?id=x", "GET"], ["/capture/share", "POST"]]) {
        const res = await proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        assert.equal(new URL(res.headers.get("location")!).pathname, "/login", `${path} needs a session`);
    }
    const tooBig = await proxy(new NextRequest("https://assistant.test/api/capture/parse-page", { method: "POST", headers: { cookie, "content-length": String(PAGE_IMAGE_BODY_LIMIT + 1) } }));
    assert.equal(tooBig.status, 413);
});

await check("share route: stages what was shared for the signed-in owner and opens Capture with a 303", async () => {
    const form = new FormData();
    form.append("title", "Bus timetable"); form.append("files", new Blob([JPEG], { type: "image/jpeg" }), "timetable.jpg");
    const res = await shareRoute.POST(new NextRequest("https://assistant.test/capture/share", { method: "POST", body: form, headers: { cookie } }));
    assert.equal(res.status, 303);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.origin, "https://assistant.test"); assert.equal(location.pathname, "/capture");
    const staged = location.searchParams.get("staged")!;
    assert.match(staged, /^[a-f0-9-]{36}$/);
    const get = (query: string, withCookie = true) => stagedRoute.GET(new NextRequest(`https://assistant.test/api/capture/staged?${query}`, { headers: withCookie ? { cookie } : {} }));
    assert.equal((await get(`id=${staged}`, false)).status, 401);
    const fields = await (await get(`id=${staged}`)).json();
    assert.deepEqual(fields, { title: "Bus timetable", text: "", url: "", skipped: 0, file: { name: "timetable.jpg", type: "image/jpeg", size: JPEG.length } });
    const file = await get(`id=${staged}&file=1`);
    assert.equal(file.headers.get("content-type"), "image/jpeg"); assert.equal(file.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), JPEG);
    assert.equal((await get("id=99999999-9999-4999-8999-999999999999")).status, 404);
    const signedOut = await shareRoute.POST(new NextRequest("https://assistant.test/capture/share", { method: "POST", body: form }));
    assert.equal(signedOut.status, 303); assert.equal(signedOut.headers.get("location"), "https://assistant.test/login?next=%2Fcapture");
    const empty = await shareRoute.POST(new NextRequest("https://assistant.test/capture/share", { method: "POST", body: new FormData(), headers: { cookie } }));
    assert.equal(new URL(empty.headers.get("location")!).searchParams.get("shareError"), "empty");
    const big = new FormData(); big.append("files", new Blob([new Uint8Array(SHARE_BODY_LIMIT)]), "huge.jpg");
    const tooBig = await shareRoute.POST(new NextRequest("https://assistant.test/capture/share", { method: "POST", body: big, headers: { cookie } }));
    assert.equal(new URL(tooBig.headers.get("location")!).searchParams.get("shareError"), "too-large");
});

function parseRow(): CatalogueRow {
    return {
        providerId: "nvidia-nim", modelId: "nvidia/nemotron-3.5-parse", kind: "parse", origin: "seed", label: "Nemotron 3.5 Parse (free)", shortName: "nemotron-3.5-parse",
        description: null, developer: null, free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: [], listedTools: null,
        listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 1700,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null, firstSeenAt: "2026-11-24T00:00:00.000Z",
        lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null, approvedAt: "2026-11-24T00:00:00.000Z",
        dimension: null, expiresAt: null, expiresSource: null, notifiedExpiryDays: null, expiryCheckedAt: null, spaceOf: null, traits: {},
    };
}

await check("parse-page route: session only, one PNG or JPEG up to 2 MB, Markdown from the parse model", async () => {
    const post = (body: Uint8Array, headers: Record<string, string> = { cookie }) => parsePageRoute.POST(new NextRequest("https://assistant.test/api/capture/parse-page", {
        method: "POST", body: new Uint8Array(body), headers: { "content-type": "image/png", origin: "https://assistant.test", ...headers },
    }));
    assert.equal((await post(PNG, { authorization: "Bearer fixture-chat" })).status, 401, "the bot's key is not a browser session");
    assert.equal((await post(PNG, { cookie, origin: "https://evil.test" })).status, 403);
    assert.equal((await post(PDF)).status, 415);
    const big = new Uint8Array(PAGE_IMAGE_BODY_LIMIT + 1); big.set(PNG);
    assert.equal((await post(big)).status, 413);
    setMediaChoicesForTests({});
    setCatalogueSnapshotForTests([parseRow()]);
    const parseCalls = () => seen.filter(call => call.url.hostname === "ai.api.nvidia.com");
    parseReply = () => Response.json({ content: tagged("**Rent reminder**", "Title") + tagged(INVOICE).replace("<y_0.1>", "<y_0.3>") });
    const ok = await post(PNG);
    assert.equal(ok.status, 200);
    // The capture title stays the only H1, so the page's own title starts at H3.
    assert.deepEqual(await ok.json(), { markdown: `### Rent reminder\n\n${INVOICE}`, model: "Nemotron 3.5 Parse (free)", method: "parse" });
    assert.equal(parseCalls().at(-1)!.url.pathname, "/v1/retrieval/nvidia/nemotron-3.5-parse/parse");
    assert.ok(seen.some(call => call.url.pathname.endsWith("/model_call_observations")), "the call is stored as an observation");
    parseReply = () => Response.json({ detail: "busy" }, { status: 503 });
    const key = process.env.NVIDIA_NIM_API_KEY;
    const failed = await post(PNG);
    assert.equal(failed.status, 502); assert.match((await failed.json()).error, /could not be read/);
    setCatalogueSnapshotForTests([]);
    delete process.env.NVIDIA_NIM_API_KEY;
    const unset = await post(PNG);
    assert.equal(unset.status, 503); assert.match((await unset.json()).error, /No page reading or vision model/);
    process.env.NVIDIA_NIM_API_KEY = key;
});

console.log(`\n${checks} capture photo checks passed.`);
