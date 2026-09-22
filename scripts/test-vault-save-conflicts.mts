import assert from "node:assert/strict";
import { commitFiles, getFile, VaultConflictError, type VaultConfig } from "../src/lib/vault/github.ts";

const HEAD = "a".repeat(40), OTHER = "b".repeat(40), CREATED = "c".repeat(40);
const PATH = "wiki/concepts/cas-test.md";
const BASE = "# Original page\n\nKeep this text.\n";
const env = {
    GEMINI_API_KEY: "test-key",
    NVIDIA_NIM_API_KEY: "test-key",
    NEXT_PUBLIC_SUPABASE_URL: "https://vault-cas-tests.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-key",
    GITHUB_VAULT_TOKEN: "test-key",
    GITHUB_VAULT_REPO: "test-owner/test-vault",
    GITHUB_VAULT_BRANCH: "main",
};
const savedEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
const cfg: VaultConfig = { owner: "test-owner", repo: "test-vault", branch: "main", token: "test-key" };
const originalFetch = globalThis.fetch;
let handler: typeof fetch = async () => { throw new Error("Unexpected fetch before the test fixture was installed."); };
globalThis.fetch = (...args) => handler(...args);
let passed = 0;

interface Call { url: URL; method: string; body: Record<string, unknown> }
function fixture(options: { source?: string | null; advanceAfterRead?: boolean; refStatus?: number; refMessage?: string } = {}) {
    const calls: Call[] = [];
    let head = HEAD;
    let parent = "";
    handler = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        calls.push({ url, method, body });
        if (url.hostname === "vault-cas-tests.supabase.co" && method === "GET") {
            if (url.pathname === "/rest/v1/vault_pages") return Response.json([{
                path: PATH, title: "Original page", summary: "Synthetic page", category: "concepts",
                embedding_model: "nvidia/nemotron-3-embed-1b", updated_at: null,
            }]);
            if (url.pathname === "/rest/v1/knowledge_documents") return Response.json({
                id: "document-id", path: PATH, title: "Original page", summary: "Synthetic page",
                category: "concepts", status: "active", scope: "user", trust: "reviewed",
            });
        }
        if (url.hostname === "api.github.com") {
            const prefix = "/repos/test-owner/test-vault";
            if (url.pathname === `${prefix}/git/ref/heads/main` && method === "GET") {
                return Response.json({ object: { sha: head } });
            }
            if (url.pathname.startsWith(`${prefix}/contents/`) && method === "GET") {
                const path = decodeURIComponent(url.pathname.slice(`${prefix}/contents/`.length));
                const text = path === PATH ? options.source === undefined ? BASE : options.source : `# ${path}\n`;
                if (path === PATH && options.advanceAfterRead) head = OTHER;
                if (text === null) return new Response(null, { status: 404 });
                return Response.json({ sha: "blob-old", type: "file", content: Buffer.from(text).toString("base64") });
            }
            if (url.pathname === `${prefix}/git/commits/${HEAD}` && method === "GET") {
                return Response.json({ tree: { sha: "tree-old" } });
            }
            if (url.pathname === `${prefix}/git/trees` && method === "POST") {
                assert.equal(body.base_tree, "tree-old");
                return Response.json({ sha: "tree-new" });
            }
            if (url.pathname === `${prefix}/git/commits` && method === "POST") {
                assert.deepEqual(body.parents, [HEAD]);
                parent = (body.parents as string[])[0];
                return Response.json({ sha: CREATED });
            }
            if (url.pathname === `${prefix}/git/refs/heads/main` && method === "PATCH") {
                assert.equal(body.force, false);
                assert.equal(body.sha, CREATED);
                if (options.refStatus) return Response.json({ message: options.refMessage ?? "Reference update failed" }, { status: options.refStatus });
                if (head !== parent) return Response.json({ message: "Update is not a fast forward" }, { status: 422 });
                head = CREATED;
                return Response.json({ object: { sha: head } });
            }
        }
        throw new Error(`Unexpected mocked request: ${method} ${url.origin}${url.pathname}`);
    };
    return { calls, head: () => head };
}

async function check(name: string, run: () => Promise<void>) {
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

try {
    const { writeVaultPage } = await import("../src/lib/vault/ingest.ts");
    const { applyKnowledgeLifecycle } = await import("../src/lib/knowledge/lifecycle.ts");
    const { resolveEmbedding } = await import("../src/lib/ai/providers.ts");
    const { PUT } = await import("../src/app/api/vault/page/route.ts");
    const { POST } = await import("../src/app/api/knowledge/documents/route.ts");
    const { NextRequest } = await import("next/server");
    const ref = resolveEmbedding("nvidia/nemotron-3-embed-1b");
    const request = (url: string, method: string, body: unknown) => new NextRequest(`http://localhost${url}`, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

    await check("fixed-revision reads use the supplied head instead of the branch", async () => {
        const f = fixture();
        assert.equal((await getFile(cfg, PATH, HEAD))?.text, BASE);
        assert.equal(f.calls[0].url.searchParams.get("ref"), HEAD);
    });

    await check("conditional commits keep the captured parent without rereading a moving head", async () => {
        const f = fixture();
        assert.equal((await commitFiles(cfg, [{ path: PATH, content: "Updated" }], "test", HEAD)).commit, CREATED);
        assert.equal(f.head(), CREATED);
        assert.ok(!f.calls.some((call) => call.url.pathname.includes("/git/ref/heads/")));
    });

    await check("legacy commits still obtain the current branch head", async () => {
        const f = fixture();
        await commitFiles(cfg, [{ path: PATH, content: "Updated" }], "test");
        assert.equal(f.calls[0].url.pathname, "/repos/test-owner/test-vault/git/ref/heads/main");
        assert.equal(f.head(), CREATED);
    });

    await check("stale or deleted source fails before creating any Git objects", async () => {
        for (const source of ["A newer page", null, BASE.trimEnd()]) {
            const f = fixture({ source });
            await assert.rejects(writeVaultPage({ path: PATH, markdown: "Changed", expectedMarkdown: BASE, embRef: ref }), VaultConflictError);
            assert.ok(f.calls.every((call) => call.method === "GET"));
            assert.equal(f.head(), HEAD);
        }
    });

    await check("a racing vault save reads page, index and log at one head and preserves the winner", async () => {
        const f = fixture({ advanceAfterRead: true });
        await assert.rejects(writeVaultPage({ path: PATH, markdown: "Changed", expectedMarkdown: BASE, embRef: ref }), VaultConflictError);
        const reads = f.calls.filter((call) => call.url.pathname.includes("/contents/"));
        assert.equal(reads.length, 3);
        assert.ok(reads.every((call) => call.url.searchParams.get("ref") === HEAD));
        assert.equal(f.head(), OTHER);
        assert.ok(f.calls.every((call) => call.url.hostname === "api.github.com"));
    });

    await check("a racing knowledge correction also preserves the winner before indexing", async () => {
        const f = fixture({ advanceAfterRead: true });
        await assert.rejects(applyKnowledgeLifecycle({ action: "correct", documentId: "document-id", markdown: "Changed", expectedMarkdown: BASE }), VaultConflictError);
        const reads = f.calls.filter((call) => call.url.pathname.includes("/contents/"));
        assert.equal(reads.length, 1);
        assert.equal(reads[0].url.searchParams.get("ref"), HEAD);
        assert.equal(f.head(), OTHER);
        assert.ok(f.calls.filter((call) => call.url.hostname.endsWith("supabase.co")).every((call) => call.method === "GET"));
    });

    await check("reference conflicts are typed while permission failures stay distinct", async () => {
        for (const status of [409, 422]) {
            fixture({ refStatus: status });
            await assert.rejects(commitFiles(cfg, [{ path: PATH, content: "Updated" }], "test", HEAD), VaultConflictError);
        }
        fixture({ refStatus: 400, refMessage: "Update is not a fast forward" });
        await assert.rejects(commitFiles(cfg, [{ path: PATH, content: "Updated" }], "test", HEAD), VaultConflictError);
        fixture({ refStatus: 403, refMessage: "Forbidden" });
        await assert.rejects(commitFiles(cfg, [{ path: PATH, content: "Updated" }], "test", HEAD), (error: unknown) =>
            error instanceof Error && !(error instanceof VaultConflictError) && /GitHub 403/.test(error.message));
    });

    await check("web correction routes reject missing or non-string bases without network work", async () => {
        const f = fixture();
        for (const expectedMarkdown of [undefined, null, 42]) {
            assert.equal((await PUT(request("/api/vault/page", "PUT", { path: PATH, markdown: "Changed", expectedMarkdown }))).status, 400);
            assert.equal((await POST(request("/api/knowledge/documents", "POST", { action: "correct", documentId: "document-id", markdown: "Changed", expectedMarkdown }))).status, 400);
        }
        assert.equal(f.calls.length, 0);
    });

    await check("both web correction routes return 409 for a stale base and preserve stored content", async () => {
        for (const route of ["vault", "knowledge"]) {
            const f = fixture({ source: "Newer version" });
            const response = route === "vault"
                ? await PUT(request("/api/vault/page", "PUT", { path: PATH, markdown: "Changed", expectedMarkdown: BASE }))
                : await POST(request("/api/knowledge/documents", "POST", { action: "correct", documentId: "document-id", markdown: "Changed", expectedMarkdown: BASE }));
            assert.equal(response.status, 409);
            assert.match((await response.json()).error, /Your draft is safe/);
            assert.ok(f.calls.every((call) => call.method === "GET"));
            assert.equal(f.head(), HEAD);
        }
    });

    await check("both web correction routes return 409 for a concurrent head advance", async () => {
        for (const route of ["vault", "knowledge"]) {
            const f = fixture({ advanceAfterRead: true });
            const response = route === "vault"
                ? await PUT(request("/api/vault/page", "PUT", { path: PATH, markdown: "Changed", expectedMarkdown: BASE }))
                : await POST(request("/api/knowledge/documents", "POST", { action: "correct", documentId: "document-id", markdown: "Changed", expectedMarkdown: BASE }));
            assert.equal(response.status, 409);
            assert.equal(f.head(), OTHER);
            assert.ok(f.calls.filter((call) => call.url.hostname.endsWith("supabase.co")).every((call) => call.method === "GET"));
        }
    });

    console.log(`${passed} mocked vault-save conflict checks passed; no network requests were sent.`);
} finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
