import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import PDFDocument from "pdfkit";
import { PGlite } from "@electric-sql/pglite";
import { isPublicAddress } from "../src/lib/capture/fetch/address";
import { checkSourceUrl, fetchSource, SourceFetchError, type FetchOptions } from "../src/lib/capture/fetch/http";
import { extractHtml } from "../src/lib/capture/extract/html";
import { extractPdfText } from "../src/lib/capture/extract/pdf";
import { decodeText } from "../src/lib/capture/extract/text";
import { extractCapture, ocrCapture } from "../src/lib/capture/extract";
import { ocrTiers, transcribePdf } from "../src/lib/capture/extract/ocr";
import { acquireSlot } from "../src/lib/capture/extract/gate";
import { CaptureError, createCaptureService, OCR_STALE_MS } from "../src/lib/capture/service";
import { serializeFrontmatter } from "../src/lib/knowledge/markdown";
import type { CaptureExtract, CaptureItem } from "../src/lib/capture/types";

delete process.env.GEMINI_FREE_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.CAPTURE_FETCH;
let passed = 0;
async function check(name: string, test: () => Promise<void> | void) { await test(); passed++; console.log(`PASS ${name}`); }
const reason = (expected: string) => (error: unknown) => { assert.ok(error instanceof SourceFetchError, String(error)); assert.equal(error.reason, expected, error.message); return true; };

function pdf(draw: (doc: PDFKit.PDFDocument) => void, options: PDFKit.PDFDocumentOptions = {}): Promise<Buffer> {
    return new Promise((resolve) => {
        const doc = new PDFDocument(options), chunks: Buffer[] = [];
        doc.on("data", (chunk: Buffer) => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks)));
        draw(doc); doc.end();
    });
}
const para = "Capture reads the text layer of this document. ".repeat(40);
const textPdf = await pdf((doc) => { for (let page = 1; page <= 3; page++) { doc.fontSize(18).text(`Section ${page}`); doc.fontSize(11).text(para); if (page < 3) doc.addPage(); } });
const icon = await readFile(new URL("../public/icons/icon-512.png", import.meta.url));
const scannedPdf = await pdf((doc) => { doc.image(icon, 50, 50, { width: 400 }); doc.addPage(); doc.image(icon, 50, 50, { width: 400 }); });
const lockedPdf = await pdf((doc) => doc.text(para), { userPassword: "fixture", ownerPassword: "fixture-owner" });

await check("address policy refuses every non-public range", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1",
        "198.18.0.1", "192.0.2.1", "240.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
        "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2001:0:4136:e378::1",
        "2130706433", "0177.0.0.1", "0x7f.0.0.1", "not-an-address", ""]) assert.equal(isPublicAddress(address), false, address);
    for (const address of ["8.8.8.8", "1.1.1.1", "203.2.218.214", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(address), true, address);
});
await check("URL check refuses private literals in any notation, other ports, schemes and credentials", () => {
    for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://0177.0.0.1/", "http://0x7f.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
        "http://169.254.169.254/latest/meta-data", "http://[64:ff9b::a9fe:a9fe]/", "http://example.com:8080/", "ftp://example.com/", "file:///etc/passwd",
        "https://user:secret@example.com/", "not a url"]) assert.throws(() => checkSourceUrl(url), reason("blocked"), url);
    assert.equal(checkSourceUrl("https://example.com/a?b=1").href, "https://example.com/a?b=1");
    assert.equal(checkSourceUrl("http://example.com:80/").port, "");
});

const gzipBomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x61));
let requests = 0;
const server = http.createServer((req, res) => {
    requests++;
    const path = req.url ?? "/";
    const redirect = path.match(/^\/redirect\/(\d+)$/);
    if (redirect) { const left = Number(redirect[1]); res.writeHead(302, { location: left > 1 ? `/redirect/${left - 1}` : "/page" }); res.end(); return; }
    switch (path) {
        case "/page": res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<html><head><title>Fixture</title></head><body><p>Hello from the fixture.</p></body></html>"); return;
        case "/to-private": res.writeHead(302, { location: `http://inner.test:${port}/page` }); res.end(); return;
        case "/to-metadata": res.writeHead(301, { location: `http://169.254.169.254:${port}/latest` }); res.end(); return;
        case "/large": res.writeHead(200, { "content-type": "text/html" }); res.write("<p>" + "x".repeat(4000)); res.end("</p>"); return;
        case "/large-declared": res.writeHead(200, { "content-type": "text/html", "content-length": "5000" }); res.end("y".repeat(5000)); return;
        case "/bomb": res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); res.end(gzipBomb); return;
        case "/slow": res.writeHead(200, { "content-type": "text/html" }); res.write("<p>"); return;
        case "/image": res.writeHead(200, { "content-type": "image/png" }); res.end(icon); return;
        case "/latin": res.writeHead(200, { "content-type": "text/html; charset=windows-1252" }); res.end(Buffer.from([0x3c, 0x70, 0x3e, 0x93, 0x53, 0x6d, 0x61, 0x72, 0x74, 0x94, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])); return;
        case "/missing": res.writeHead(404, { "content-type": "text/html" }); res.end("gone"); return;
        case "/doc.pdf": res.writeHead(200, { "content-type": "application/pdf" }); res.end(textPdf); return;
        case "/sniffed": res.writeHead(200); res.end(textPdf); return;
        case "/thin": res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body><div id=app>Loading</div><script>boot()</script></body></html>"); return;
        default: res.writeHead(500); res.end();
    }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const site = (path: string) => `http://site.test:${port}${path}`;
const local: FetchOptions = {
    policy: (address) => address === "127.0.0.1",
    resolver: async (host) => host === "inner.test" ? [{ address: "10.1.2.3", family: 4 }] : host === "mixed.test" ? [{ address: "127.0.0.1", family: 4 }, { address: "192.168.0.9", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
    ports: new Set([port]), totalMs: 3_000, connectMs: 1_000,
};
try {
    await check("fetcher follows redirects and reports the final URL", async () => {
        const fetched = await fetchSource(site("/redirect/5"), local);
        assert.equal(fetched.kind, "html"); assert.equal(fetched.finalUrl, site("/page")); assert.equal(fetched.charset, "utf-8");
        await assert.rejects(fetchSource(site("/redirect/6"), local), reason("redirects"));
    });
    await check("fetcher refuses redirects and hosts that reach a refused address before connecting", async () => {
        const before = requests;
        await assert.rejects(fetchSource(`http://inner.test:${port}/page`, local), reason("blocked"));
        await assert.rejects(fetchSource(`http://mixed.test:${port}/page`, local), reason("blocked"));
        assert.equal(requests, before);
        await assert.rejects(fetchSource(site("/to-private"), local), reason("blocked"));
        await assert.rejects(fetchSource(site("/to-metadata"), local), reason("blocked"));
        assert.equal(requests, before + 2);
    });
    await check("fetcher caps size, decoded size, time and content type", async () => {
        await assert.rejects(fetchSource(site("/large"), { ...local, limits: { html: 1024 } }), reason("size"));
        await assert.rejects(fetchSource(site("/large-declared"), { ...local, limits: { html: 1024 } }), reason("size"));
        assert.ok(gzipBomb.length < 100_000);
        await assert.rejects(fetchSource(site("/bomb"), local), reason("size"));
        const started = Date.now();
        await assert.rejects(fetchSource(site("/slow"), { ...local, totalMs: 400 }), reason("timeout"));
        assert.ok(Date.now() - started < 2_000);
        await assert.rejects(fetchSource(site("/image"), local), reason("type"));
        await assert.rejects(fetchSource(site("/missing"), local), (error) => reason("http")(error) && (error as SourceFetchError).status === 404);
    });
    await check("fetcher decodes windows-1252 and sniffs an undeclared PDF", async () => {
        const latin = await fetchSource(site("/latin"), local);
        assert.equal(latin.charset, "windows-1252");
        assert.equal(decodeText(latin.body, latin.charset), "<p>“Smart” café</p>");
        assert.equal((await fetchSource(site("/sniffed"), local)).kind, "pdf");
    });
    await check("link captures read pages, PDFs and failures into extract records", async () => {
        const now = () => new Date("2026-11-18T00:00:00.000Z");
        const linked = await extractCapture({ kind: "link", title: "PDF", text: "", url: site("/doc.pdf") }, { fetchOptions: local, now });
        assert.equal(linked.method, "pdf-text"); assert.equal(linked.status, "ok"); assert.equal(linked.pages, 3); assert.equal(linked.contentType, "application/pdf");
        assert.equal(linked.fetchedAt, "2026-11-18T00:00:00.000Z"); assert.match(linked.text, /Section 2/);
        const thin = await extractCapture({ kind: "link", title: "App", text: "", url: site("/thin") }, { fetchOptions: local, now });
        assert.equal(thin.status, "empty"); assert.match(thin.note ?? "", /JavaScript|sign-in/);
        const refused = await extractCapture({ kind: "link", title: "Inner", text: "", url: `http://inner.test:${port}/page` }, { fetchOptions: local, now });
        assert.equal(refused.status, "blocked"); assert.equal(refused.text, "");
        const missing = await extractCapture({ kind: "link", title: "Missing", text: "", url: site("/missing") }, { fetchOptions: local, now });
        assert.equal(missing.status, "failed"); assert.match(missing.note ?? "", /404/);
        process.env.CAPTURE_FETCH = "off";
        const off = await extractCapture({ kind: "link", title: "Off", text: "", url: site("/page") }, { fetchOptions: local, now });
        delete process.env.CAPTURE_FETCH;
        assert.equal(off.status, "failed"); assert.match(off.note ?? "", /turned off/);
        await assert.rejects(extractCapture({ kind: "text", title: "Text", text: "Passage" }), CaptureError);
    });
} finally {
    server.closeAllConnections(); server.close();
}

await check("HTML becomes Markdown with metadata, image links, demoted headings and no outbound requests", async () => {
    const realFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = async () => { outbound++; throw new Error("Extraction must not make network requests"); };
    try {
        const body = Array.from({ length: 6 }, (_, index) => `<p>Paragraph ${index + 1} explains how a careful reader keeps the original wording of a source while they take notes for later study.</p>`).join("");
        const page = await extractHtml(`<!doctype html><html><head><title>Fixture article | Example Site</title>
            <meta name="author" content="Ada Fixture"><meta property="og:site_name" content="Example Site"><meta property="article:published_time" content="2026-11-01T09:00:00Z"></head>
            <body><nav><a href="/">Home</a></nav><article><h1>Fixture article</h1>${body}<h2>Details</h2><p>More detail sits here.</p>
            <img src="/images/diagram.png" alt="A labelled diagram"><script>track()</script></article><footer>Footer links</footer></body></html>`, "https://example.test/posts/fixture");
        assert.equal(page.status, "ok");
        assert.equal(page.author, "Ada Fixture"); assert.equal(page.site, "Example Site"); assert.match(page.published ?? "", /^2026-11-01/);
        assert.match(page.title ?? "", /Fixture article/);
        assert.match(page.text, /^#### Details$/m);
        assert.doesNotMatch(page.text, /^#{1,2} /m);
        assert.match(page.text, /\[Image: A labelled diagram\]\(https:\/\/example\.test\/images\/diagram\.png\)/);
        assert.doesNotMatch(page.text, /!\[|track\(\)/);
        assert.equal(outbound, 0);
    } finally { globalThis.fetch = realFetch; }
});
await check("PDF text, scanned, locked, malformed and page cap", async () => {
    const text = await extractPdfText(textPdf);
    assert.equal(text.status, "ok"); assert.equal(text.pages, 3); assert.equal(text.truncated, false); assert.match(text.text, /Section 1[\s\S]*Section 3/);
    const scanned = await extractPdfText(scannedPdf);
    assert.equal(scanned.status, "scanned"); assert.equal(scanned.pages, 2);
    const locked = await extractPdfText(lockedPdf);
    assert.equal(locked.status, "locked"); assert.match(locked.note ?? "", /password/);
    const broken = await extractPdfText(Buffer.from("%PDF-1.4\nthis is not a real PDF body\n%%EOF"));
    assert.equal(broken.status, "failed");
    const capped = await extractPdfText(textPdf, { pageLimit: 2 });
    assert.equal(capped.status, "ok"); assert.equal(capped.truncated, true); assert.equal(capped.note, "Read the first 2 of 3 pages."); assert.doesNotMatch(capped.text, /Section 3/);
});

const profile = "owner-1";
const rows = new Map<string, CaptureItem>(), files = new Map<string, string>(), saved: CaptureExtract[] = [];
let clock = new Date("2026-11-18T01:00:00.000Z"), reads = 0, ocrCalls = 0, indexCalls = 0, ocrFails: Error | null = null, tiers = { free: true, paid: false };
const linkId = "11111111-1111-4111-8111-111111111111", pdfId = "22222222-2222-4222-8222-222222222222", textId = "33333333-3333-4333-8333-333333333333";
const htmlExtract: CaptureExtract = { version: 1, status: "ok", method: "html", text: "Fetched article body.", truncated: false, words: 3, fetchedAt: "2026-11-18T00:30:00.000Z",
    finalUrl: "https://example.test/final", contentType: "text/html", title: "Fetched", author: "Ada Fixture", published: "2026-11-01" };
const service = createCaptureService({
    get: async (owner, key) => rows.get(`${owner}:${key}`) ?? null,
    insert: async (item) => { const key = `${item.profileId}:${item.id}`; if (!rows.has(key)) rows.set(key, item); return rows.get(key)!; },
    receipt: async (owner, key, receipt) => { rows.get(`${owner}:${key}`)!.receipt = receipt; },
    claim: async (_owner, _key, claim) => claim,
    head: async () => "a".repeat(40), read: async (path) => files.get(path) ?? null,
    commit: async (changes) => { changes.forEach(change => files.set(change.path, change.content ?? change.contentBase64!)); return { commit: "b".repeat(40) }; },
    index: async () => { indexCalls++; },
    saveExtract: async (owner, key, extract) => { const row = rows.get(`${owner}:${key}`); if (row && !row.receipt) { row.extract = extract; saved.push(extract); } },
    extractor: {
        read: async (source) => { reads++; return source.kind === "pdf" ? { ...htmlExtract, method: "pdf-text", status: "scanned", text: "", words: 0, contentType: "application/pdf", pages: 2, finalUrl: undefined } : htmlExtract; },
        ocr: async (_source, stored, tier) => { ocrCalls++; if (ocrFails) throw ocrFails; return { ...htmlExtract, method: tier === "paid" ? "ocr-paid" : "ocr-free", text: "Transcribed page.", pages: stored?.pages, finalUrl: undefined }; },
        ocrTiers: async () => tiers,
        acquire: acquireSlot,
        now: () => clock,
    },
});
await service.capture(profile, linkId, { kind: "link", title: "A link", text: "My reviewed notes.", url: "https://example.test/start" });
await service.capture(profile, pdfId, { kind: "pdf", title: "A PDF", text: "PDF notes.", pdf: { name: "scan.pdf", base64: scannedPdf.toString("base64") } });
await service.capture(profile, textId, { kind: "text", title: "Text", text: "A passage." });
const review = { title: "Reviewed link", text: "My reviewed notes.", destination: "notes/reviewed-link.md" };

await check("preview without source text is byte-identical to the pre-V7 document", async () => {
    const item = rows.get(`${profile}:${linkId}`)!;
    const legacy = serializeFrontmatter({ attributes: { zuychin_id: `capture-${linkId}`, title: review.title, kind: "note", scope: "user", status: "active", trust: "untrusted",
        sensitivity: "private", capture_id: linkId, capture_source_hash: item.sourceHash }, body: ["# Reviewed link", "My reviewed notes.", "Source: <https://example.test/start>"].join("\n\n") + "\n" });
    const before = await service.preview(profile, linkId, review);
    assert.equal(before.markdown, legacy);
    item.extract = htmlExtract;
    const after = await service.preview(profile, linkId, review);
    assert.equal(after.markdown, legacy); assert.equal(after.previewHash, before.previewHash);
    assert.equal((await service.preview(profile, linkId, { ...review, sourceText: " \n " })).markdown, legacy);
    delete item.extract;
});
await check("source text adds its section and provenance frontmatter, and ingests", async () => {
    const item = rows.get(`${profile}:${linkId}`)!;
    item.extract = htmlExtract;
    const preview = await service.preview(profile, linkId, { ...review, sourceText: "Fetched article body.\r\n" });
    assert.match(preview.markdown, /\n# Reviewed link\n\nMy reviewed notes\.\n\n## Source text\n\nFetched article body\.\n\nSource: <https:\/\/example\.test\/start>\n$/);
    for (const field of [/^source_url: "?https:\/\/example\.test\/start"?$/m, /^source_final_url: "?https:\/\/example\.test\/final"?$/m, /^fetched_at: "?2026-11-18T00:30:00\.000Z"?$/m,
        /^extracted_by: "?defuddle"?$/m, /^source_author: "?Ada Fixture"?$/m, /^source_published: "?2026-11-01"?$/m]) assert.match(preview.markdown, field);
    item.extract = { ...htmlExtract, status: "running" };
    const running = await service.preview(profile, linkId, { ...review, sourceText: "Pasted by hand." });
    assert.match(running.markdown, /source_url:/); assert.doesNotMatch(running.markdown, /fetched_at|extracted_by/);
    item.extract = htmlExtract;
    await assert.rejects(service.preview(profile, linkId, { ...review, sourceText: "x".repeat(120_001) }));
    const receipt = await service.ingest(profile, preview);
    assert.equal(files.get(preview.path), preview.markdown); assert.equal(receipt.indexed, false); assert.equal(indexCalls, 0);
    assert.equal(rows.get(`${profile}:${linkId}`)!.receipt?.indexed, false);
    await receipt.background!();
    assert.equal(indexCalls, 1); assert.equal(rows.get(`${profile}:${linkId}`)!.receipt?.indexed, true);
});
await check("extract reads once, keeps the stored record, refreshes on request and refuses the wrong captures", async () => {
    const pdfRow = rows.get(`${profile}:${pdfId}`)!;
    const first = await service.extract(profile, pdfId);
    assert.equal(first.extract.status, "scanned"); assert.equal(first.background, undefined); assert.equal(reads, 1); assert.deepEqual(pdfRow.extract, first.extract);
    assert.equal((await service.extract(profile, pdfId)).extract, pdfRow.extract); assert.equal(reads, 1);
    await service.extract(profile, pdfId, { refresh: true }); assert.equal(reads, 2);
    const held = acquireSlot("extract")!;
    await assert.rejects(service.extract(profile, pdfId, { refresh: true }), (error: CaptureError) => error.status === 429);
    held();
    await assert.rejects(service.extract(profile, textId), (error: CaptureError) => error.status === 400 && /link and PDF/.test(error.message));
    await assert.rejects(service.extract(profile, linkId), (error: CaptureError) => error.status === 409);
    await assert.rejects(service.extract("other", pdfId), (error: CaptureError) => error.status === 404);
    const bare = createCaptureService({ get: async () => pdfRow } as unknown as Parameters<typeof createCaptureService>[0]);
    await assert.rejects(bare.extract(profile, pdfId), (error: CaptureError) => error.status === 503);
});
await check("OCR runs in the background with one slot, a running state and tier checks", async () => {
    const pdfRow = rows.get(`${profile}:${pdfId}`)!;
    await assert.rejects(service.extract(profile, pdfId, { ocr: "paid" }), (error: CaptureError) => error.status === 403 && /Free only/.test(error.message));
    const started = await service.extract(profile, pdfId, { ocr: "free" });
    assert.equal(started.extract.status, "running"); assert.equal(started.extract.method, "ocr-free"); assert.equal(started.extract.pages, 2);
    assert.equal(pdfRow.extract?.status, "running"); assert.ok(started.background); assert.equal(ocrCalls, 0);
    const again = await service.extract(profile, pdfId, { ocr: "free" });
    assert.equal(again.extract.status, "running"); assert.equal(again.background, undefined);
    assert.equal((await service.extract(profile, pdfId, { refresh: true })).extract.status, "running"); assert.equal(reads, 2);
    const otherPdf = "44444444-4444-4444-8444-444444444444";
    await service.capture(profile, otherPdf, { kind: "pdf", title: "Second PDF", text: "", pdf: { name: "b.pdf", base64: scannedPdf.toString("base64") } });
    await assert.rejects(service.extract(profile, otherPdf, { ocr: "free" }), (error: CaptureError) => error.status === 429);
    await started.background!();
    assert.equal(ocrCalls, 1); assert.equal(pdfRow.extract?.status, "ok"); assert.equal(pdfRow.extract?.method, "ocr-free"); assert.equal(pdfRow.extract?.pages, 2);
    ocrFails = new CaptureError("The link no longer serves a PDF.");
    const failing = await service.extract(profile, otherPdf, { ocr: "free" });
    await failing.background!();
    const failed = rows.get(`${profile}:${otherPdf}`)!.extract!;
    assert.equal(failed.status, "failed"); assert.equal(failed.note, "The link no longer serves a PDF.");
    ocrFails = new Error("socket hang up");
    await (await service.extract(profile, otherPdf, { ocr: "free" })).background!();
    assert.equal(rows.get(`${profile}:${otherPdf}`)!.extract!.note, "Gemini could not read the PDF. Try again.");
    ocrFails = null;
    tiers = { free: true, paid: true };
    const paid = await service.extract(profile, otherPdf, { ocr: "paid" });
    assert.equal(paid.extract.method, "ocr-paid"); await paid.background!();
    const linkOnly = "55555555-5555-4555-8555-555555555555";
    await service.capture(profile, linkOnly, { kind: "link", title: "Page", text: "", url: "https://example.test/page" });
    await assert.rejects(service.extract(profile, linkOnly, { ocr: "free" }), /PDFs only/);
    await service.extract(profile, linkOnly);
    await assert.rejects(service.extract(profile, linkOnly, { ocr: "free" }), /PDFs only/);
    tiers = { free: true, paid: false };
});
await check("a running OCR older than ten minutes is marked failed", async () => {
    const pdfRow = rows.get(`${profile}:${pdfId}`)!;
    const startedAt = new Date(clock.getTime() - OCR_STALE_MS - 1_000).toISOString();
    pdfRow.extract = { ...htmlExtract, status: "running", method: "ocr-free", text: "", startedAt, fetchedAt: startedAt };
    const stale = await service.extract(profile, pdfId);
    assert.equal(stale.extract.status, "failed"); assert.equal(stale.extract.note, "Gemini didn't finish. Try again."); assert.equal(pdfRow.extract.status, "failed");
    pdfRow.extract = { ...htmlExtract, status: "running", method: "ocr-free", text: "", startedAt: clock.toISOString(), fetchedAt: clock.toISOString() };
    assert.equal((await service.extract(profile, pdfId)).extract.status, "running");
    clock = new Date(clock.getTime() + OCR_STALE_MS + 1);
    const restarted = await service.extract(profile, pdfId, { ocr: "free" });
    assert.equal(restarted.extract.status, "running"); assert.equal(pdfRow.extract.startedAt, clock.toISOString());
    assert.equal(acquireSlot("ocr"), null);
    await restarted.background!();
    assert.equal(pdfRow.extract.status, "ok");
});
await check("Gemini OCR tiers, missing keys, truncation and empty results", async () => {
    assert.deepEqual(ocrTiers(false), { free: false, paid: false });
    process.env.GEMINI_FREE_API_KEY = "fixture-free"; process.env.GEMINI_API_KEY = "fixture-paid";
    assert.deepEqual(ocrTiers(false), { free: true, paid: true });
    assert.deepEqual(ocrTiers(true), { free: true, paid: false });
    await assert.rejects(transcribePdf(scannedPdf, "paid", { freeOnly: true }), (error: CaptureError) => error.status === 403);
    delete process.env.GEMINI_FREE_API_KEY; delete process.env.GEMINI_API_KEY;
    await assert.rejects(transcribePdf(scannedPdf, "free", { freeOnly: false }), (error: CaptureError) => error.status === 403 && /free Gemini key/.test(error.message));
    const source = { kind: "pdf" as const, title: "Scan", text: "", pdf: { name: "scan.pdf", base64: scannedPdf.toString("base64") } };
    const stored: CaptureExtract = { version: 1, status: "scanned", method: "pdf-text", text: "", truncated: false, words: 0, fetchedAt: clock.toISOString(), contentType: "application/pdf", pages: 2 };
    let sent: Uint8Array | null = null;
    const full = await ocrCapture(source, stored, "free", { freeOnly: true, generate: async (bytes) => { sent = bytes; return { text: "# Page one\n\nScanned words.", candidates: [{ finishReason: "STOP" }] }; } });
    assert.equal(full.status, "ok"); assert.equal(full.method, "ocr-free"); assert.equal(full.truncated, false); assert.equal(full.pages, 2);
    assert.match(full.text, /^### Page one/m); assert.ok(sent && Buffer.from(sent).equals(scannedPdf));
    const cut = await ocrCapture(source, stored, "paid", { freeOnly: false, generate: async () => ({ text: "Partial words.", candidates: [{ finishReason: "MAX_TOKENS" }] }) });
    assert.equal(cut.method, "ocr-paid"); assert.equal(cut.truncated, true); assert.equal(cut.note, "Gemini stopped before the end of the PDF.");
    const failing = (error: unknown) => async () => { throw error; };
    for (const [error, tier, message] of [
        [Object.assign(new Error("high demand"), { status: 503 }), "free", /busy right now/], [Object.assign(new Error("quota"), { status: 429 }), "free", /free Gemini quota/],
        [Object.assign(new Error("quota"), { status: 429 }), "paid", /rate limited/], [new DOMException("timed out", "TimeoutError"), "paid", /took too long/],
    ] as const) await assert.rejects(transcribePdf(scannedPdf, tier, { freeOnly: false, generate: failing(error) }), (thrown: unknown) => thrown instanceof CaptureError && message.test(thrown.message));
    await assert.rejects(transcribePdf(scannedPdf, "free", { freeOnly: true, generate: failing(new Error("socket hang up")) }), (thrown: unknown) => !(thrown instanceof CaptureError));
    const blank = await ocrCapture(source, stored, "free", { freeOnly: true, generate: async () => ({ text: "  " }) });
    assert.equal(blank.status, "empty"); assert.equal(blank.note, "Gemini found no readable text.");
    const picture = await ocrCapture(source, stored, "free", { freeOnly: true, generate: async () => ({ text: "[no text]\n", candidates: [{ finishReason: "STOP" }] }) });
    assert.equal(picture.status, "empty"); assert.equal(picture.text, "");
    await assert.rejects(ocrCapture({ kind: "text", title: "T", text: "x" }, null, "free", { freeOnly: true, generate: async () => ({ text: "x" }) }), /PDF/);
    const link = { kind: "link" as const, title: "L", text: "", url: "https://example.test/doc.pdf" };
    const generate = async () => ({ text: "x" });
    await assert.rejects(ocrCapture(link, stored, "free", { freeOnly: true, generate, fetch: async () => { throw new SourceFetchError("http", "The site answered HTTP 410.", 410); } }),
        (error: unknown) => error instanceof CaptureError && error.message === "The site answered HTTP 410.");
    await assert.rejects(ocrCapture(link, stored, "free", { freeOnly: true, generate, fetch: async () => ({ finalUrl: link.url, status: 200, kind: "html", contentType: "text/html", body: Buffer.from("<p>") }) }),
        /no longer serves a PDF/);
    const relinked = await ocrCapture(link, { ...stored, finalUrl: "https://example.test/final.pdf" }, "free", { freeOnly: true, generate,
        fetch: async () => ({ finalUrl: link.url, status: 200, kind: "pdf", contentType: "application/pdf", body: scannedPdf }) });
    assert.equal(relinked.status, "ok"); assert.equal(relinked.finalUrl, "https://example.test/final.pdf");
});

await check("the V7 migration applies twice after the capture inbox, refuses without it, and is embedded in setup", async () => {
    const migration = await readFile(new URL("./migrations/v7-capture-extract.sql", import.meta.url), "utf8");
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    assert.ok(setup.includes(`-- ===== V7 capture extract =====\n-- v7-capture-extract.sql\n${migration.trimEnd()}`), "supabase-setup.sql must embed v7-capture-extract.sql verbatim");
    assert.ok(!migration.includes("\r"), "LF line endings");
    const bare = new PGlite();
    await assert.rejects(bare.exec(migration), /Apply v6-capture-inbox\.sql before v7-capture-extract\.sql/);
    await bare.close();
    const db = new PGlite();
    try {
        await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
        const table = setup.match(/create table if not exists user_profiles \([\s\S]*?\n\);/);
        assert.ok(table); await db.exec(table[0]);
        await db.exec(await readFile(new URL("./migrations/v6-capture-inbox.sql", import.meta.url), "utf8"));
        await db.exec(migration); await db.exec(migration);
        const owner = "66666666-6666-4666-8666-666666666666", key = "77777777-7777-4777-8777-777777777777";
        await db.query("insert into user_profiles(id) values ($1)", [owner]);
        await db.query("insert into capture_inbox(profile_id,id,source,source_hash) values ($1,$2,$3,$4)", [owner, key, JSON.stringify({ kind: "link" }), "c".repeat(64)]);
        const value = (await db.query<{ extract: unknown }>("select extract from capture_inbox where id = $1", [key])).rows[0].extract;
        assert.equal(value, null);
        await db.query("update capture_inbox set extract = $1 where id = $2", [JSON.stringify(htmlExtract), key]);
        const status = (await db.query<{ status: string }>("select extract->>'status' as status from capture_inbox where id = $1", [key])).rows[0].status;
        assert.equal(status, "ok");
        await assert.rejects(db.query("update capture_inbox set extract = '[1]'::jsonb where id = $1", [key]), /capture_inbox_extract_shape/);
        await assert.rejects(db.query("update capture_inbox set extract = $1 where id = $2", [JSON.stringify({ text: "x".repeat(1_000_001) }), key]), /capture_inbox_extract_shape/);
        const constraints = (await db.query<{ count: number }>("select count(*)::int as count from pg_constraint where conname = 'capture_inbox_extract_shape'")).rows[0].count;
        assert.equal(constraints, 1);
    } finally { await db.close(); }
});

console.log(`\nCapture extract: ${passed} checks passed (address policy, guarded fetcher, HTML and PDF extraction, source text documents, OCR states and the V7 migration). No live services were used.`);
