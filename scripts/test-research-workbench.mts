import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { createResearchService } from "../src/lib/research/service";
import { createRevisionService } from "../src/lib/knowledge/revisions";
import { hashContent } from "../src/lib/knowledge/markdown";
import * as research from "../src/lib/research/contracts";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://research.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "offline-anon-fixture";
process.env.SUPABASE_SERVICE_ROLE_KEY = "offline-fixture";
process.env.AUTH_SESSION_SECRET = "offline-research-session-secret";
process.env.CHAT_API_KEY = "offline-chat-key";
const { createResearchHandlers } = await import("../src/lib/research/api");
const { createSessionValue } = await import("../src/lib/auth/session");
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", foreignId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "99999999-9999-4999-8999-999999999999";
const questionId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const entryId = "33333333-3333-4333-8333-333333333333";
assert.deepEqual(research.parseResearchEntry({ id: entryId, questionId, kind: "interpretation", text: "My interpretation" }), { id: entryId, questionId, kind: "interpretation", text: "My interpretation", sourceId: null });
assert.throws(() => research!.parseResearchEntry({ id: entryId, questionId, kind: "claim", text: "Unsupported claim" }), /passage/);
assert.throws(() => research!.parseResearchEntry({ id: entryId, questionId, sourceId, kind: "claim", text: "Claim", quote: "Quoted", startOffset: -1 }), /offset/);
const sha = "a".repeat(40), nextSha = "b".repeat(40), documentId = "doc-evidence";
const markdown = "---\nzuychin_id: doc-evidence\n---\n# Evaluation\n🧠 Accuracy rose by 5 points.\n<script>literal quote</script>\n";
const quote = "Accuracy rose by 5 points.", offset = markdown.indexOf(quote);
type Row = Record<string, unknown>;
const doc = { id: documentId, path: "wiki/sources/evidence.md", title: "Evidence", project_id: null, user_profile_id: null, scope: "user", status: "active" };
const qrow = { id: questionId, user_profile_id: userId, project_id: projectId, title: "Compare methods", question: "Which method improves accuracy?", status: "active", version: 1, updated_at: "2026-09-28T00:00:00Z" };
const tables: Record<string, Row[]> = { projects: [{ id: projectId, user_profile_id: userId, name: "Study" }], research_questions: [qrow], research_sources: [], research_entries: [], knowledge_documents: [{ ...doc }] };
let reads = 0, gitReads = 0, head = sha, missing = false;
let capacity: string | null = null, duringRead: (() => void) | undefined;
const writes: { action: string; payload: Row }[] = [];
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const client = createClient("https://research.invalid", "fixture-key", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/rpc/assistant_research_mutate")) {
        if (missing) return response({ code: "PGRST202", message: "missing" }, 404);
        if (capacity) return response({ capacity });
        const { p_action: action, p_payload: p, p_user_id: owner } = JSON.parse(String(init?.body));
        assert.equal(owner, userId); writes.push({ action, payload: p });
        const table = action.includes("question") ? "research_questions" : action.includes("source") ? "research_sources" : "research_entries";
        const rows = tables[table], existing = rows.find((row) => row.id === p.id);
        if ((action.startsWith("update") || action.startsWith("edit") || action.startsWith("delete")) && existing?.version !== p.version) return response({ conflict: true, current: existing });
        if (action === "delete_entry") { rows.splice(rows.indexOf(existing!), 1); return response({ deleted: true, id: p.id }); }
        let row: Row;
        if (action === "add_source") row = { id: p.id, user_profile_id: owner, question_id: p.questionId, document_id: p.documentId, path: p.path, commit_sha: p.commitSha, content_hash: p.contentHash, title: p.title, removed_at: null, version: 1 };
        else if (action === "edit_source") row = { ...existing, ...(p.title ? { title: p.title } : {}), ...(p.remove ? { removed_at: "2026-09-28" } : {}), version: Number(existing!.version) + 1 };
        else if (table === "research_questions") row = { id: p.id, user_profile_id: owner, project_id: p.projectId, title: p.title, question: p.question, status: p.status, version: Number(existing?.version ?? 0) + 1 };
        else row = { id: p.id, user_profile_id: owner, question_id: p.questionId, source_id: p.sourceId, kind: p.kind, text: p.text, evidence: p.evidence, version: Number(existing?.version ?? 0) + 1 };
        row.updated_at = "2026-09-28T00:00:00Z";
        if (existing) rows[rows.indexOf(existing)] = row; else rows.push(row);
        return response(row);
    }
    reads++;
    const table = url.pathname.split("/").at(-1)!;
    assert.ok(tables[table], `Unexpected transport ${url.pathname}`);
    let rows = tables[table].filter((row) => [...url.searchParams].every(([key, value]) => !value.startsWith("eq.") || String(row[key]) === value.slice(3)));
    const limit = Number(url.searchParams.get("limit")); if (limit) rows = rows.slice(0, limit);
    return response(url.searchParams.has("id") ? rows[0] ?? null : rows);
} } });
const revisions = createRevisionService({
    getDocument: async (id) => id === documentId ? { ...doc, summary: "", category: "research", trust: "reference", sensitivity: "private" } : null,
    getHead: async () => head, isAncestor: async (value) => [sha, nextSha].includes(value),
    getFile: async (_path, revision) => { gitReads++; duringRead?.(); return { text: revision === sha ? markdown.replace(/\n/g, "\r\n") : markdown.replace("5 points", "9 points"), sha: "blob" }; },
    list: async () => ({ revisions: [], hasMore: false }),
    commit: async () => { throw new Error("Research must not write Git"); },
    index: async () => { throw new Error("Research must not index"); },
    recordEvent: async () => { throw new Error("Research must not restore"); },
});
const service = createResearchService(client, revisions);
const handlers = createResearchHandlers(service, { userId: async () => userId });
const cookie = `zuychin-auth=${await createSessionValue()}`;
const request = (path: string, body?: unknown, method = "GET", headers: Record<string, string> = { cookie }) => new NextRequest(`http://localhost${path}`, { method, headers: { ...headers, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
let count = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) { await run(); count++; console.log(`PASS ${name}`); }
await test("anonymous and bearer-only access denied before storage", async () => {
    for (const headers of [{}, { authorization: "Bearer offline-chat-key" }] as Record<string, string>[]) assert.equal((await handlers.GET(request("/api/research", undefined, "GET", headers))).status, 401);
    assert.equal(reads, 0);
});
await test("owner session lists owned projects and questions", async () => {
    const result = await handlers.GET(request("/api/research")); assert.equal(result.status, 200); assert.match(result.headers.get("cache-control")!, /no-store/);
    assert.equal((await result.json()).questions.length, 1);
});
await test("signed session does not authorise cross-origin mutations", async () => {
    const before = writes.length;
    assert.equal((await handlers.POST(request("/api/research", { id: questionId, projectId, title: "Injected", question: "Injected" }, "POST", { cookie, origin: "https://other.invalid" }))).status, 403);
    assert.equal(writes.length, before);
});
await test("expected profile prevents stale-account writes before mutation", async () => {
    const before = writes.length;
    const result = await handlers.POST(request("/api/research", { id: questionId, projectId, title: "Stale", question: "Stale" }, "POST", { cookie, "X-Research-Profile": foreignId }));
    assert.equal(result.status, 409); assert.equal((await result.json()).profileChanged, true); assert.equal(writes.length, before);
});
await test("session client clears on account change and fences late private responses", async () => {
    const { createResearchSessionClient } = await import("../src/lib/research/session-client");
    let clears = 0, mode = "initial", resolveLate: ((response: Response) => void) | undefined;
    const client = createResearchSessionClient(() => { clears++; }, async (_url, init) => {
        if (mode !== "initial") assert.equal(new Headers(init?.headers).get("X-Research-Profile"), userId);
        if (mode === "late") return new Promise<Response>(resolve => { resolveLate = resolve; });
        return new Response(JSON.stringify({ secret: "private draft" }), { status: mode === "expired" ? 401 : 200, headers: { "Content-Type": "application/json", "X-Research-Profile": mode === "switched" ? foreignId : userId } });
    });
    await client.request("/api/research"); mode = "late";
    const pending = client.request("/api/research"); client.invalidate(); resolveLate!(new Response(JSON.stringify({ secret: "must not render" }), { headers: { "X-Research-Profile": userId } }));
    await assert.rejects(pending, { name: "AbortError" }); assert.equal(clears, 1);
    mode = "initial"; await client.request("/api/research"); mode = "switched";
    await assert.rejects(client.request("/api/research"), { name: "AbortError" }); assert.equal(clears, 2);
    mode = "initial"; await client.request("/api/research"); mode = "expired";
    await assert.rejects(client.request("/api/research"), { name: "AbortError" }); assert.equal(clears, 3);
});
await test("existing shared Library accepted; foreign, session and otherproject sources rejected", () => {
    assert.equal(research.documentInResearchScope(doc, userId, projectId), true);
    for (const patch of [{ user_profile_id: foreignId }, { project_id: foreignId }, { status: "archived" }, { scope: "session" }]) assert.equal(research.documentInResearchScope({ ...doc, ...patch }, userId, projectId), false);
});
await test("foreign project/question cannot be read", async () => {
    await assert.rejects(service.workspace(questionId, foreignId), /unavailable/);
    tables.projects[0].user_profile_id = foreignId;
    await assert.rejects(service.workspace(questionId, userId), /unavailable/); tables.projects[0].user_profile_id = userId;
});
await test("selection validates immutable revision and LF content hash", async () => {
    const result = await handlers.sourcePOST(request("/api/research/sources", { id: sourceId, questionId, documentId }, "POST")); assert.equal(result.status, 200);
    const { source } = await result.json(); assert.equal(source.commitSha, sha); assert.equal(source.contentHash, hashContent(markdown));
});
await test("lost-ack retry preserves original revision after vault head changes", async () => {
    head = nextSha; const before = gitReads;
    const source = await service.addSource({ id: sourceId, questionId, documentId }, userId);
    assert.equal(source.commitSha, sha); assert.equal(gitReads, before); assert.equal(tables.research_sources.length, 1);
});
await test("routes reject fabricated identity and foreign source before Git read", async () => {
    const before = gitReads;
    assert.equal((await handlers.sourcePOST(request("/api/research/sources", { id: entryId, questionId, documentId, contentHash: "forged" }, "POST"))).status, 400);
    tables.knowledge_documents[0].user_profile_id = foreignId;
    assert.equal((await handlers.sourceGET(request(`/api/research/sources?sourceId=${sourceId}&questionId=${questionId}`))).status, 404);
    assert.equal(gitReads, before); tables.knowledge_documents[0].user_profile_id = null;
});
await test("reader remains on saved immutable revision", async () => {
    assert.equal((await service.snapshot(sourceId, questionId, userId)).markdown, markdown);
});
await test("snapshot revalidates document and project access after revision read", async () => {
    for (const [table, patch] of [["knowledge_documents", { user_profile_id: foreignId }], ["knowledge_documents", { status: "archived" }], ["knowledge_documents", { project_id: foreignId }], ["projects", { user_profile_id: foreignId }]] as const) {
        const original = { ...tables[table][0] };
        duringRead = () => Object.assign(tables[table][0], patch);
        try { await assert.rejects(service.snapshot(sourceId, questionId, userId), /unavailable|not available/); }
        finally { tables[table][0] = original; duringRead = undefined; }
    }
});
await test("capacity RPC results become truthful non-destructive API errors", async () => {
    const before = writes.length;
    for (const [kind, text] of [["questions", /500.*archived/], ["sources", /500.*removed/], ["entries", /2,000.*delete/i]] as const) {
        capacity = kind;
        const result = await handlers.POST(request("/api/research", { id: questionId, projectId, title: "Compare", question: "Why?" }, "POST"));
        assert.equal(result.status, 413); assert.match((await result.json()).error, text);
    }
    capacity = null; assert.equal(writes.length, before);
});
const claim = { id: entryId, questionId, sourceId, kind: "finding", text: "The reported improvement was five points.", quote, startOffset: offset };
await test("actual evidence helper validates UTF16 offsets and hashes", async () => {
    const entry = await service.saveEntry(claim, userId);
    assert.equal(entry.evidence?.quote, quote); assert.equal(entry.evidence?.quoteHash, hashContent(quote));
    assert.equal(entry.evidence?.startOffset, offset); assert.equal(entry.evidence?.endOffset, offset + quote.length); assert.equal(entry.evidence?.commitSha, sha);
});
await test("forged quotes, wrong offsets and stored hash mismatch never mutate", async () => {
    const before = writes.length;
    await assert.rejects(service.saveEntry({ ...claim, quote: "fabricated" }, userId), /passage|quote/i);
    await assert.rejects(service.saveEntry({ ...claim, startOffset: offset - 1 }, userId), /passage|quote/i);
    tables.research_sources[0].content_hash = "f".repeat(64);
    await assert.rejects(service.saveEntry(claim, userId), /immutable source/);
    tables.research_sources[0].content_hash = hashContent(markdown); assert.equal(writes.length, before);
});
await test("stale save returns current version without replacing saved text", async () => {
    const result = await handlers.entryPOST(request("/api/research/entries", { ...claim, text: "Stale local draft", version: 99 }, "POST"));
    assert.equal(result.status, 409); const body = await result.json(); assert.equal(body.current.text, claim.text); assert.equal(body.current.version, 1);
    assert.equal(tables.research_entries[0].text, claim.text);
});
await test("authored interpretation has no fabricated evidence", async () => {
    const result = await service.saveEntry({ id: "44444444-4444-4444-8444-444444444444", questionId, kind: "interpretation", text: "My hypothesis requires another experiment." }, userId);
    assert.equal(result.evidence, null); assert.equal(result.sourceId, null);
});
await test("source removal preserves evidence, blocks new notes, allows existing edit", async () => {
    const before = JSON.stringify(tables.research_entries[0].evidence);
    await service.editSource({ id: sourceId, questionId, version: 1, remove: true }, userId);
    const workspace = await service.workspace(questionId, userId); assert.ok(workspace.sources[0].removedAt);
    assert.equal(JSON.stringify(workspace.entries[0].evidence), before);
    await assert.rejects(service.saveEntry({ ...claim, id: "55555555-5555-4555-8555-555555555555" }, userId), /removed/);
    assert.equal((await service.saveEntry({ ...claim, version: 1, text: "A clearer description." }, userId)).version, 2);
});
await test("delete stale version conflicts before successful retry", async () => {
    assert.equal((await handlers.entryDELETE(request("/api/research/entries", { id: entryId, questionId, version: 1 }, "DELETE"))).status, 409);
    const id = "44444444-4444-4444-8444-444444444444";
    assert.equal((await handlers.entryDELETE(request("/api/research/entries", { id, questionId, version: 1 }, "DELETE"))).status, 200);
    assert.equal(tables.research_entries.some((entry) => entry.id === id), false);
});
await test("missing migration is reported honestly", async () => {
    missing = true;
    const result = await handlers.POST(request("/api/research", { id: questionId, projectId, title: "Compare", question: "Why?", version: 1 }, "POST"));
    assert.equal(result.status, 503); assert.match((await result.json()).error, /migration/); missing = false;
});
await test("oversized listing fails rather than silently omitting notes", async () => {
    const original = tables.research_entries; tables.research_entries = Array.from({ length: 2001 }, () => original[0]);
    await assert.rejects(service.workspace(questionId, userId), /silently omitted/); tables.research_entries = original;
});
await test("comparison distinguishes authored notes from escaped quotes and removed sources", async () => {
    const workspace = await service.workspace(questionId, userId);
    workspace.entries[0].text = "<script>authored note</script>"; workspace.entries[0].evidence!.quote = "<script>literal quote</script>";
    assert.equal(research.researchComparison(workspace)[0].findings.length, 1);
    const require = createRequire(import.meta.url), old = require.extensions[".css"];
    require.extensions[".css"] = (module) => { module.exports = { __esModule: true, default: new Proxy({}, { get: (_target, key) => String(key) }) }; };
    try {
        const { ResearchComparison } = await import("../src/app/research/workbench");
        const { createElement } = await import("react"), { renderToStaticMarkup } = await import("react-dom/server");
        const html = renderToStaticMarkup(createElement(ResearchComparison, { workspace }));
        for (const text of ["Methods", "Findings", "Limitations", "your source-linked notes", "Quoted evidence", "Removed from selection", "aaaaaaaa", "&lt;script&gt;"]) assert.ok(html.includes(text), text);
        assert.equal(html.includes("<script>"), false);
    } finally { if (old) require.extensions[".css"] = old; else delete require.extensions[".css"]; }
});
await test("SQL static security and null-safe scope review", () => {
    const sql = readFileSync(new URL("./migrations/v6-research-workbench.sql", import.meta.url), "utf8");
    assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/);
    assert.equal((sql.match(/is distinct from expected_version/g) ?? []).length, 3);
    assert.equal((sql.match(/d\.scope in \('user','repository'\)\)\) is not true/g) ?? []).length, 2);
    assert.match(sql, /for update/); assert.match(sql, /row level security/);
});
console.log(`Research workbench: ${count} checks passed plus 3 contract assertions (mocked database/Git; SQL not executed).`);
