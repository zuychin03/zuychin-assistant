import assert from "node:assert/strict";

Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://capture-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat", GEMINI_API_KEY: "fixture-gemini", GITHUB_VAULT_TOKEN: "fixture-vault", GITHUB_VAULT_REPO: "fixture/vault" });
const profile = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const calls: { url: URL; method: string }[] = [];
const rows = new Map<string, Record<string, unknown>>();
let profileUnavailable = false;
let sourcesUnavailable = false;
const project = "44444444-4444-4444-8444-444444444444";
const sourceRows = [
    { id: "owned", path: "notes/owned.md", title: "Owned", user_profile_id: profile, project_id: project, scope: "project", status: "active" },
    { id: "shared", path: "notes/shared.md", title: "Shared", user_profile_id: null, project_id: null, scope: "repository", status: "active" },
    { id: "user", path: "notes/user.md", title: "User", user_profile_id: null, project_id: null, scope: "user", status: "active" },
    { id: "foreign-owner", path: "notes/foreign.md", title: "Foreign owner", user_profile_id: "other", project_id: project, scope: "project", status: "active" },
    { id: "foreign-project", path: "notes/project.md", title: "Foreign project", user_profile_id: null, project_id: "other", scope: "project", status: "active" },
    { id: "unknown-scope", path: "notes/unknown.md", title: "Unknown", user_profile_id: null, project_id: null, scope: null, status: "active" },
];
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined, url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET", body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method });
    if (url.hostname === "capture-fixture.supabase.co") {
        if (url.pathname.endsWith("/user_profiles")) return profileUnavailable ? Response.json({ message: "offline" }, { status: 503 }) : Response.json({ id: profile, preferences: { freeOnly: true } });
        if (url.pathname.endsWith("/projects")) { assert.equal(url.searchParams.get("user_profile_id"), `eq.${profile}`); return Response.json([{ id: project }]); }
        if (url.pathname.endsWith("/knowledge_documents")) {
            if (sourcesUnavailable) return Response.json({ message: "unavailable" }, { status: 503 });
            const documentId = url.searchParams.get("id")?.slice(3);
            if (documentId) return Response.json(sourceRows.find(row => row.id === documentId) ?? null);
            assert.equal(url.searchParams.get("status"), "eq.active");
            return Response.json(sourceRows);
        }
        assert.equal(url.pathname, "/rest/v1/capture_inbox");
        if (method === "POST") {
            assert.equal(body.profile_id, profile);
            if (!rows.has(body.id)) rows.set(body.id, { ...body, created_at: new Date().toISOString(), receipt: null });
            assert.match(new Headers(init?.headers).get("prefer")!, /ignore-duplicates/);
            return new Response(null, { status: 201 });
        }
        assert.equal(url.searchParams.get("profile_id"), `eq.${profile}`);
        const key = url.searchParams.get("id")?.slice(3);
        return Response.json(key ? rows.get(key) ?? null : []);
    }
    assert.equal(url.hostname, "api.github.com", "Capture must not fetch source URLs or call a model before review");
    assert.equal(method, "GET", "Review must not ingest anything");
    if (url.pathname.includes("/git/ref/")) return Response.json({ object: { sha: "a".repeat(40) } });
    if (url.pathname.includes("/contents/notes/owned.md")) return Response.json({ type: "file", encoding: "base64", content: Buffer.from("---\nzuychin_id: owned\n---\nOwned source").toString("base64"), sha: "b".repeat(40), size: 45 });
    if (url.pathname.includes("/contents/")) return new Response(null, { status: 404 });
    throw new Error("Unexpected offline route request");
};
const route = await import("../src/app/api/capture/route");
const session = await import("../src/app/api/capture/session/route");
const original = await import("../src/app/api/capture/original/route");
const download = await import("../src/app/api/capture/download/route");
const { NextRequest } = await import("next/server");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
const req = (path: string, body?: unknown, auth = true) => new NextRequest(`https://fixture.invalid${path}`, { method: body ? "POST" : "GET", headers: { ...(auth ? { authorization: "Bearer fixture-chat" } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
for (const handler of [route.GET, session.GET, original.GET, download.GET]) assert.equal((await handler(req("/api/capture", undefined, false))).status, 401);
assert.equal((await route.POST(req("/api/capture", {}, false))).status, 401); assert.equal(calls.length, 0);
assert.equal((await route.POST(req("/api/capture", { action: "capture", profileId: "other", id, source: {} }))).status, 409);
assert.equal(rows.size, 0);
const ownerSession = await createSessionValue();
const crossed = new NextRequest("https://fixture.invalid/api/capture", { method: "POST", headers: { cookie: `${AUTH_COOKIE}=${ownerSession}`, origin: "https://sibling.fixture.invalid", "Content-Type": "text/plain" }, body: JSON.stringify({ action: "capture", profileId: profile, id, source: {} }) });
const beforeCrossed = calls.length;
assert.equal((await route.POST(crossed)).status, 403); assert.equal(calls.length, beforeCrossed);
crossed.headers.set("origin", "https://fixture.invalid");
assert.equal((await route.POST(crossed)).status, 400);
const source = { kind: "link", title: "A source", text: "Reviewed selected passage", url: "https://example.invalid/source" };
const save = () => route.POST(req("/api/capture", { action: "capture", profileId: profile, id, source }));
assert.equal((await save()).status, 200); assert.equal((await save()).status, 200); assert.equal(rows.size, 1);
assert.equal((await route.POST(req("/api/capture", { action: "capture", profileId: profile, id, source: { ...source, text: "Altered replay" } }))).status, 409);
const preview = await route.POST(req("/api/capture", { action: "preview", profileId: profile, id, review: { title: "Reviewed source", text: "Reviewed notes", destination: "notes/reviewed.md" } }));
assert.equal(preview.status, 200); assert.match((await preview.json()).markdown, /trust: untrusted/);
assert.equal(calls.some(call => call.url.hostname === "api.github.com" && call.method !== "GET"), false);
assert.equal((await route.POST(req("/api/capture", { action: "preview", profileId: profile, id, review: { title: "Escape", text: "", destination: "../private.md" } }))).status, 400);
const pdfId = "33333333-3333-4333-8333-333333333333";
assert.equal((await route.POST(req("/api/capture", { action: "capture", profileId: profile, id: pdfId, source: { kind: "pdf", title: "Source PDF", text: "Manually reviewed note", pdf: { name: "source.pdf", base64: Buffer.from("%PDF-1.4\nfixture").toString("base64") } } }))).status, 200);
const pdf = await original.GET(req(`/api/capture/original?id=${pdfId}`));
assert.equal(pdf.status, 200); assert.equal(pdf.headers.get("cache-control"), "private, no-store"); assert.match(await pdf.text(), /^%PDF/);
const inbox = await route.GET(req("/api/capture"));
assert.equal(inbox.status, 200); assert.deepEqual((await inbox.json()).documents.map((document: { id: string }) => document.id), ["owned", "shared", "user"]);
for (const documentId of ["foreign-owner", "foreign-project", "unknown-scope", "missing"]) {
    const beforeGit = calls.filter(call => call.url.hostname === "api.github.com").length;
    assert.equal((await download.GET(req(`/api/capture/download?documentId=${documentId}`))).status, 404);
    assert.equal(calls.filter(call => call.url.hostname === "api.github.com").length, beforeGit);
}
const downloaded = await download.GET(req("/api/capture/download?documentId=owned"));
assert.equal(downloaded.status, 200); assert.equal((await downloaded.json()).profileId, profile);
sourcesUnavailable = true;
assert.equal((await route.GET(req("/api/capture"))).status, 503);
assert.equal((await download.GET(req("/api/capture/download?documentId=owned"))).status, 503);
sourcesUnavailable = false;
profileUnavailable = true;
assert.equal((await session.GET(req("/api/capture/session"))).status, 503);
console.log("Capture routes: authentication, profile binding, idempotent replay, reviewed destination, no background ingestion, PDF original, scoped source listing/download and outage handling passed.");
