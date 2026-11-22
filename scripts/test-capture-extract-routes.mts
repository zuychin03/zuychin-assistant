import assert from "node:assert/strict";
import PDFDocument from "pdfkit";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://capture-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat", GEMINI_API_KEY: "fixture-gemini", GITHUB_VAULT_TOKEN: "fixture-vault", GITHUB_VAULT_REPO: "fixture/vault" });
delete process.env.GEMINI_FREE_API_KEY; delete process.env.CAPTURE_FETCH;
const profile = "11111111-1111-4111-8111-111111111111";
const pdfId = "22222222-2222-4222-8222-222222222222", linkId = "33333333-3333-4333-8333-333333333333", textId = "44444444-4444-4444-8444-444444444444";
const rows = new Map<string, Record<string, unknown>>();
const patches: { url: URL; body: Record<string, unknown> }[] = [];
let outside = 0, noExtractColumn = false;
const missingColumn = (code: string, message: string) => Response.json({ code, message, details: null, hint: null }, { status: 400 });
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined, url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET", body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url.hostname !== "capture-fixture.supabase.co") { outside++; throw new Error(`Unexpected request to ${url.hostname}`); }
    if (url.pathname.endsWith("/user_profiles")) return Response.json({ id: profile, preferences: { freeOnly: true } });
    if (url.pathname.endsWith("/projects")) return Response.json([]);
    if (url.pathname.endsWith("/knowledge_documents")) return Response.json([]);
    assert.equal(url.pathname, "/rest/v1/capture_inbox");
    if (method === "POST") {
        if (!rows.has(body.id)) rows.set(body.id, { ...body, created_at: new Date().toISOString(), receipt: null, extract: null });
        return new Response(null, { status: 201 });
    }
    assert.equal(url.searchParams.get("profile_id"), `eq.${profile}`);
    const key = url.searchParams.get("id")?.slice(3);
    if (method === "PATCH") {
        if (noExtractColumn && "extract" in body) return missingColumn("PGRST204", "Could not find the 'extract' column of 'capture_inbox' in the schema cache");
        patches.push({ url, body });
        const row = rows.get(key!);
        if (row && (url.searchParams.get("receipt") !== "is.null" || row.receipt === null)) Object.assign(row, body);
        return new Response(null, { status: 204 });
    }
    const select = url.searchParams.get("select") ?? "";
    if (key) {
        const row = rows.get(key);
        if (!row) return Response.json(null);
        if (!noExtractColumn) return Response.json(row);
        const legacy = { ...row };
        delete legacy.extract;
        return Response.json(legacy);
    }
    if (noExtractColumn && select.includes("extract")) return missingColumn("42703", "column capture_inbox.extract does not exist");
    return Response.json([...rows.values()].map((row) => {
        const source = row.source as { kind: string; title: string; text: string; url?: string; pdf?: { name: string } };
        const extract = row.extract as { status?: string } | null;
        return { id: row.id, profile_id: row.profile_id, source_hash: row.source_hash, created_at: row.created_at, receipt: row.receipt, kind: source.kind, title: source.title,
            text: source.text, url: source.url ?? null, pdf_name: source.pdf?.name ?? null, source_ref: null, ...(select.includes("extract_status") ? { extract_status: extract?.status ?? null } : {}) };
    }));
};
const route = await import("../src/app/api/capture/route");
const { acquireSlot } = await import("../src/lib/capture/extract/gate");
const { NextRequest } = await import("next/server");
const { createSessionValue } = await import("../src/lib/auth/session");
// Sign-out-everywhere reads would add a request these exact request counts do not expect.
(await import("../src/lib/auth/session-epoch")).setSessionEpochSourceForTests(async () => null);
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
const req = (body?: unknown, auth = true) => new NextRequest("https://fixture.invalid/api/capture", { method: body ? "POST" : "GET",
    headers: { ...(auth ? { authorization: "Bearer fixture-chat" } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const post = async (body: Record<string, unknown>) => { const response = await route.POST(req({ profileId: profile, ...body })); return { status: response.status, body: await response.json() }; };
const extract = (id: string, options: Record<string, unknown> = {}) => post({ action: "extract", id, ...options });

const textPdf = await new Promise<Buffer>((resolve) => {
    const doc = new PDFDocument(), chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks)));
    for (let page = 1; page <= 3; page++) { doc.text(`Section ${page} `.repeat(30)); if (page < 3) doc.addPage(); }
    doc.end();
});
assert.equal((await post({ action: "capture", id: pdfId, source: { kind: "pdf", title: "A PDF", text: "", pdf: { name: "a.pdf", base64: textPdf.toString("base64") } } })).status, 200);
assert.equal((await post({ action: "capture", id: linkId, source: { kind: "link", title: "A link", text: "", url: "https://example.invalid/article" } })).status, 200);
assert.equal((await post({ action: "capture", id: textId, source: { kind: "text", title: "Text", text: "A passage." } })).status, 200);

assert.equal((await route.POST(req({ action: "extract", profileId: profile, id: pdfId }, false))).status, 401);
const crossed = new NextRequest("https://fixture.invalid/api/capture", { method: "POST", headers: { cookie: `${AUTH_COOKIE}=${await createSessionValue()}`, origin: "https://sibling.fixture.invalid",
    "Content-Type": "text/plain" }, body: JSON.stringify({ action: "extract", profileId: profile, id: pdfId }) });
assert.equal((await route.POST(crossed)).status, 403);
assert.equal((await post({ action: "extract", id: pdfId, profileId: "other" })).status, 409);
assert.equal((await extract(pdfId, { refresh: "yes" })).status, 400);
assert.equal((await extract(pdfId, { ocr: "gold" })).status, 400);
const textRefused = await extract(textId);
assert.equal(textRefused.status, 400); assert.match(textRefused.body.error, /link and PDF/);
assert.equal(patches.length, 0);

const first = await extract(pdfId);
assert.equal(first.status, 200); assert.equal(first.body.extract.status, "ok"); assert.equal(first.body.extract.method, "pdf-text"); assert.equal(first.body.extract.pages, 3);
assert.match(first.body.extract.text, /Section 2/);
assert.equal(patches.length, 1); assert.equal(patches[0].url.searchParams.get("receipt"), "is.null"); assert.deepEqual(patches[0].body.extract, first.body.extract);
const stored = await extract(pdfId);
assert.equal(stored.status, 200); assert.equal(stored.body.extract.fetchedAt, first.body.extract.fetchedAt); assert.equal(patches.length, 1);
assert.equal((await extract(pdfId, { refresh: true })).status, 200); assert.equal(patches.length, 2);
const held = acquireSlot("extract")!;
const busy = await extract(pdfId, { refresh: true });
held();
assert.equal(busy.status, 429); assert.equal(patches.length, 2);

process.env.CAPTURE_FETCH = "off";
const link = await extract(linkId);
delete process.env.CAPTURE_FETCH;
assert.equal(link.status, 200); assert.equal(link.body.extract.status, "failed"); assert.match(link.body.extract.note, /turned off/);

const paid = await extract(pdfId, { ocr: "paid" });
assert.equal(paid.status, 403); assert.match(paid.body.error, /Free only/);
const free = await extract(pdfId, { ocr: "free" });
assert.equal(free.status, 403); assert.match(free.body.error, /free Gemini key/);
assert.equal((rows.get(pdfId)!.extract as { status: string }).status, "ok");

const inbox = await route.GET(req());
const listed = await inbox.json();
assert.equal(inbox.status, 200); assert.deepEqual(listed.ocr, { free: false, paid: false });
const statuses = Object.fromEntries(listed.items.map((item: { id: string; extractStatus?: string | null }) => [item.id, item.extractStatus]));
assert.deepEqual(statuses, { [pdfId]: "ok", [linkId]: "failed", [textId]: null });
assert.equal(JSON.stringify(listed).includes("Section 2"), false, "The list must not carry source text");
process.env.GEMINI_FREE_API_KEY = "fixture-free";
assert.deepEqual((await (await route.GET(req())).json()).ocr, { free: true, paid: false });
delete process.env.GEMINI_FREE_API_KEY;

noExtractColumn = true;
const legacyInbox = await route.GET(req());
assert.equal(legacyInbox.status, 200);
assert.equal((await legacyInbox.json()).items.some((item: Record<string, unknown>) => "extractStatus" in item), false);
const unmigrated = await extract(pdfId);
assert.equal(unmigrated.status, 503); assert.match(unmigrated.body.error, /v7-capture-extract\.sql/);
noExtractColumn = false;

rows.get(pdfId)!.receipt = { path: "notes/a.md", commit: "a".repeat(40), indexed: true };
const fixed = await extract(pdfId, { refresh: true });
assert.equal(fixed.status, 409); assert.match(fixed.body.error, /already in knowledge/);
assert.equal(outside, 0);
console.log("Capture extract routes: auth, same origin, profile binding, option validation, kind and receipt refusals, stored reuse, refresh, the busy gate, Free only OCR refusals, list statuses and OCR flags, and the unmigrated database passed.");
