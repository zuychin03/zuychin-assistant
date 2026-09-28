import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://revision-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat",
    GITHUB_VAULT_TOKEN: "fixture-vault", GITHUB_VAULT_REPO: "fixture/vault", GITHUB_VAULT_BRANCH: "main", GEMINI_API_KEY: "fixture-gemini",
});
const oldSha = "a".repeat(40), headSha = "b".repeat(40);
const markdown = "---\nzuychin_id: doc-1\n---\n# Exact source\n\nA saved passage.\n";
const requests: { url: URL; method: string }[] = [];
let unsupportedContent = false;
let documentAccess = { scope: "user", user_profile_id: null as string | null, project_id: null as string | null };
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    requests.push({ url, method });
    assert.equal(method, "GET", "No write is expected from these route fixtures");
    if (url.hostname === "revision-fixture.supabase.co") {
        if (url.pathname === "/rest/v1/user_profiles") return Response.json({ id: "owner" });
        if (url.pathname === "/rest/v1/projects") {
            assert.equal(url.searchParams.get("user_profile_id"), "eq.owner");
            return Response.json(documentAccess.project_id === "owned" ? { id: "owned" } : null);
        }
        assert.equal(url.pathname, "/rest/v1/knowledge_documents");
        return Response.json({ id: "doc-1", path: "notes/example.md", title: "Example", summary: "", category: "notes", ...documentAccess, trust: "reviewed", status: "archived", sensitivity: "private" });
    }
    assert.equal(url.hostname, "api.github.com");
    assert.ok(url.pathname.startsWith("/repos/fixture/vault/"));
    assert.ok(init?.signal, "Vault reads are bounded");
    if (url.pathname.includes("/git/ref/")) return Response.json({ object: { sha: headSha } });
    if (url.pathname.includes("/compare/")) return Response.json({ status: url.pathname.includes(oldSha) ? "ahead" : "diverged" });
    if (url.pathname.includes("/contents/")) {
        assert.equal(url.pathname, "/repos/fixture/vault/contents/notes/example.md");
        assert.ok([oldSha, headSha].includes(url.searchParams.get("ref")!));
        return Response.json({ type: "file", sha: "f".repeat(40), encoding: unsupportedContent ? "none" : "base64", content: unsupportedContent ? "" : Buffer.from(markdown).toString("base64") });
    }
    if (url.pathname.endsWith("/commits")) return Response.json([{ sha: oldSha, commit: { message: "Create example", author: { name: "Fixture", date: "2026-09-01T00:00:00Z" } } }]);
    throw new Error("Unexpected offline request");
};
const revisions = await import("../src/app/api/knowledge/revisions/route");
const evidence = await import("../src/app/api/knowledge/evidence/route");
const { NextRequest } = await import("next/server");
const req = (path: string, body?: unknown, authorised = true) => new NextRequest(`https://fixture.invalid${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { ...(authorised ? { authorization: "Bearer fixture-chat" } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});
let checks = 0;
async function check(name: string, run: () => Promise<void>) { requests.length = 0; await run(); console.log(`PASS ${name}`); checks++; }
await check("all revision and evidence endpoints reject unauthenticated reads and writes", async () => {
    for (const route of [revisions, evidence]) {
        assert.equal((await route.GET(req("/api/knowledge/revisions", undefined, false))).status, 401);
        assert.equal((await route.POST(req("/api/knowledge/revisions", {}, false))).status, 401);
    }
    assert.equal(requests.length, 0);
});
await check("malformed JSON and mutable refs fail before outbound reads", async () => {
    assert.equal((await revisions.POST(req("/api/knowledge/revisions", "{"))).status, 400);
    assert.equal((await evidence.POST(req("/api/knowledge/evidence", "{"))).status, 400);
    assert.equal((await evidence.GET(req("/api/knowledge/evidence?documentId=doc-1&commitSha=main"))).status, 400);
    assert.equal(requests.length, 0);
});
await check("cross-origin writes fail before source reads", async () => {
    for (const route of [revisions, evidence]) {
        const request = req("/api/knowledge/revisions", {}); request.headers.set("origin", "https://sibling.fixture.invalid");
        assert.equal((await route.POST(request)).status, 403);
    }
    assert.equal(requests.length, 0);
});
await check("foreign owners, foreign projects and session scope cannot read or restore", async () => {
    for (const access of [{ scope: "user", user_profile_id: "foreign", project_id: null }, { scope: "project", user_profile_id: null, project_id: "foreign" }, { scope: "session", user_profile_id: null, project_id: null }]) {
        documentAccess = access; requests.length = 0;
        assert.equal((await revisions.GET(req("/api/knowledge/revisions?documentId=doc-1"))).status, 404);
        assert.equal((await evidence.GET(req(`/api/knowledge/evidence?documentId=doc-1&commitSha=${oldSha}`))).status, 404);
        assert.equal((await evidence.POST(req("/api/knowledge/evidence", { documentId: "doc-1", commitSha: oldSha, quote: "A saved passage." }))).status, 404);
        assert.equal((await revisions.POST(req("/api/knowledge/revisions", { documentId: "doc-1", sourceSha: oldSha, sourcePath: "notes/example.md", headSha, currentHash: null, previewHash: "f".repeat(64) }))).status, 404);
        assert.equal(requests.some(({ url }) => url.hostname === "api.github.com"), false);
    }
    for (const access of [{ scope: "project", user_profile_id: "owner", project_id: "owned" }, { scope: "repository", user_profile_id: null, project_id: null }]) {
        documentAccess = access;
        assert.equal((await revisions.GET(req("/api/knowledge/revisions?documentId=doc-1"))).status, 200);
    }
    documentAccess = { scope: "user", user_profile_id: null, project_id: null };
});
await check("default store lists only configured repository and pinned head", async () => {
    const response = await revisions.GET(req("/api/knowledge/revisions?documentId=doc-1"));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json(); assert.equal(body.headSha, headSha); assert.equal(body.revisions[0].commitSha, oldSha);
    assert.equal(requests.find(({ url }) => url.pathname.endsWith("/commits"))?.url.searchParams.get("sha"), headSha);
});
await check("snapshot and evidence routes retain the exact immutable content", async () => {
    const response = await evidence.GET(req(`/api/knowledge/evidence?documentId=doc-1&commitSha=${oldSha}`));
    assert.equal(response.status, 200); assert.equal((await response.json()).markdown, markdown);
    const quote = "A saved passage.";
    const saved = await evidence.POST(req("/api/knowledge/evidence", { documentId: "doc-1", commitSha: oldSha, quote }));
    assert.equal(saved.status, 200); const body = await saved.json();
    assert.equal(markdown.slice(body.startOffset, body.endOffset), quote); assert.equal(body.commitSha, oldSha);
});
await check("path traversal and unrelated history cannot become source evidence", async () => {
    assert.equal((await evidence.GET(req(`/api/knowledge/evidence?documentId=doc-1&commitSha=${oldSha}&path=..%2Fsecret.md`))).status, 400);
    assert.equal((await evidence.GET(req(`/api/knowledge/evidence?documentId=doc-1&commitSha=${"c".repeat(40)}`))).status, 404);
    assert.equal(requests.some(({ url }) => url.pathname.includes("/contents/")), false);
});
await check("restore requires the reviewed preview and rejects stale state before writing", async () => {
    const response = await revisions.GET(req(`/api/knowledge/revisions?documentId=doc-1&sourceSha=${oldSha}`));
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal((await revisions.POST(req("/api/knowledge/revisions", { ...body, headSha: "c".repeat(40) }))).status, 409);
    assert.equal((await revisions.POST(req("/api/knowledge/revisions", { ...body, sourcePath: undefined }))).status, 400);
});
await check("unsupported provider content cannot be mistaken for an empty revision", async () => {
    unsupportedContent = true;
    const response = await evidence.GET(req(`/api/knowledge/evidence?documentId=doc-1&commitSha=${oldSha}`));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "The source snapshot is unavailable." });
});
console.log(`${checks} knowledge route checks passed with offline adapters.`);
