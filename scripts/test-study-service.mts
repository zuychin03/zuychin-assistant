import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createStudyService } from "../src/lib/study/service";
import { initialSchedule } from "../src/lib/study/scheduler";
import type { KnowledgeEvidence } from "../src/lib/knowledge/revision-types";

Object.assign(process.env, { AUTH_SESSION_SECRET: "study-fixture-session", CHAT_API_KEY: "study-fixture-chat" });
const owner = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333", project = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-09-28T00:00:00Z");
const evidence: KnowledgeEvidence = { version: 1, documentId: "doc", path: "wiki/sources/study.md", commitSha: "a".repeat(40), contentHash: "b".repeat(64), quote: "Source evidence", quoteHash: "c".repeat(64), startOffset: 3, endOffset: 18 };
let documents = [{ id: "doc", title: "Study source", path: evidence.path, project_id: project as string | null, user_profile_id: owner as string | null, scope: "project", status: "active" }];
let row = { id, user_profile_id: owner, deck: "Study", kind: "recall", prompt: "Question", answer: "Answer", evidence, schedule: initialSchedule(now), version: 1, active: true, updated_at: now.toISOString() };
const calls: { name: string; body: Record<string, unknown>; url: URL }[] = [];
let failure = "", evidenceCalls = 0;
const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "study-fixture.supabase.co");
    const name = url.pathname.replace("/rest/v1/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ name, body, url });
    if (failure === "missing") return Response.json({ code: "PGRST202", message: "missing" }, { status: 404 });
    if (name === "projects") return Response.json([{ id: project }]);
    if (name === "knowledge_documents") return Response.json(documents);
    if (name === "study_cards") { assert.equal(url.searchParams.get("user_profile_id"), `eq.${owner}`); return Response.json(failure === "absent" ? null : row); }
    if (name === "rpc/assistant_study_report") return Response.json({ settings: { daily_limit: 20, timezone: "Australia/Sydney", version: 1 }, reviewed_today: 0, day: "2026-09-28", generated_at: now.toISOString(), cards: [row], reviews: [] });
    if (name === "rpc/assistant_study_save") {
        if (failure === "conflict") return Response.json({ error: "conflict" });
        const payload = body.p_body;
        assert.equal(body.p_user_id, owner);
        if (body.p_action === "create") row = { ...row, ...payload, user_profile_id: owner };
        return Response.json({ card: row, settings: body.p_body });
    }
    if (name === "rpc/assistant_study_review") {
        if (failure) return Response.json({ error: failure });
        const payload = body.p_body;
        assert.equal(body.p_user_id, owner);
        return Response.json({ review: { id: payload.id, card_id: id, rating: payload.rating, response: payload.response, reflection: payload.reflection, reviewed_at: now.toISOString(), prompt: row.prompt, answer: row.answer, evidence, card_version: 1 }, reused: true });
    }
    throw new Error(`Unexpected fixture path ${name}`);
};
const db = createClient("https://study-fixture.supabase.co", "fixture-key", { global: { fetch: fetcher } });
const revisions = {
    list: async () => ({ documentId: "doc", path: evidence.path, headSha: evidence.commitSha, page: 1, revisions: [], hasMore: false }),
    snapshot: async () => ({ documentId: "doc", path: evidence.path, commitSha: evidence.commitSha, contentHash: evidence.contentHash, markdown: "xx Source evidence" }),
    evidence: async (input: { quote: string; startOffset?: number }) => { evidenceCalls++; assert.equal(input.quote, evidence.quote); assert.equal(input.startOffset, 3); return evidence; },
};
const service = createStudyService(db, revisions, () => now);
const input = { id, deck: "Study", kind: "recall", prompt: "Question", answer: "Answer", documentId: "doc", path: evidence.path, commitSha: evidence.commitSha, quote: evidence.quote, startOffset: 3 };
const reviewBody = { id: crypto.randomUUID(), cardId: id, version: 1, rating: 3, response: "My answer", reflection: "A correction" };
let passed = 0;
async function check(name: string, fn: () => unknown) { failure = ""; await fn(); passed++; console.log(`PASS ${name}`); }
await check("report returns permitted sources and exact server daily count", async () => { const report = await service.report(owner); assert.equal(report.documents.length, 1); assert.equal(report.reviewedToday, 0); assert.equal(report.settings.timezone, "Australia/Sydney"); });
await check("source creation verifies the immutable passage before save", async () => { const saved = await service.create(input, owner); assert.deepEqual(saved.card.evidence, evidence); assert.equal(evidenceCalls, 1); assert.equal(calls.at(-1)?.body.p_user_id, owner); });
await check("caller cannot replace evidence or submit ownership", async () => { await assert.rejects(service.create({ ...input, userProfileId: other }, owner)); await assert.rejects(service.create({ ...input, evidence: { quote: "forged" } }, owner)); });
await check("foreign owner and foreign project sources fail before revision reads", async () => {
    const before = evidenceCalls;
    documents = [{ ...documents[0], user_profile_id: other }]; await assert.rejects(service.create(input, owner), /not available/);
    documents = [{ ...documents[0], user_profile_id: null, project_id: other }]; await assert.rejects(service.snapshot("doc", owner), /not available/);
    assert.equal(evidenceCalls, before); documents = [{ ...documents[0], user_profile_id: owner, project_id: project }];
});
await check("shared repository sources are allowed without leaking other scopes", async () => {
    documents = [{ ...documents[0], user_profile_id: null, project_id: null, scope: "repository" }]; assert.equal((await service.report(owner)).documents.length, 1);
    documents = [{ ...documents[0], scope: "private-unknown" }]; assert.equal((await service.report(owner)).documents.length, 0);
    documents = [{ ...documents[0], user_profile_id: owner, project_id: project, scope: "project" }];
});
await check("review sends server-generated FSRS state and stable idempotency hash", async () => {
    assert.equal((await service.review(reviewBody, owner)).reused, true);
    const first = calls.at(-1)!.body.p_body as Record<string, unknown>;
    await service.review(reviewBody, owner);
    const second = calls.at(-1)!.body.p_body as Record<string, unknown>;
    assert.equal(first.requestHash, second.requestHash); assert.equal(first.id, reviewBody.id);
    assert.ok(Date.parse((first.schedule as { due: string }).due) > now.getTime());
    await service.review({ ...reviewBody, response: "Different answer" }, owner);
    assert.notEqual((calls.at(-1)!.body.p_body as Record<string, unknown>).requestHash, first.requestHash);
});
for (const status of ["conflict", "daily_limit", "not_due", "absent", "missing"]) await check(`review handles ${status} without a false success`, async () => { failure = status; await assert.rejects(service.review(reviewBody, owner)); });
await check("edits cannot rewrite evidence or scheduler fields", async () => { await assert.rejects(service.edit({ id, version: 1, deck: "Study", prompt: "Q", answer: "A", active: true, evidence }, owner)); });
await check("settings require a real timezone and bounded review count", async () => { await assert.rejects(service.settings({ dailyLimit: 0, timezone: "Australia/Sydney", version: 1 }, owner)); await assert.rejects(service.settings({ dailyLimit: 20, timezone: "Invalid/Zone", version: 1 }, owner)); });

const { createStudyHandlers } = await import("../src/lib/study/api");
const { NextRequest } = await import("next/server");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
const session = await createSessionValue();
const handlers = createStudyHandlers(service, async () => owner);
const req = (method = "GET", body?: unknown, auth = true) => new NextRequest("https://fixture.invalid/api/study", { method, headers: { "Content-Type": "application/json", ...(auth ? { cookie: `${AUTH_COOKIE}=${session}` } : { authorization: "Bearer study-fixture-chat" }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
await check("API requires an owner session before any source reads", async () => { const before = calls.length; assert.equal((await handlers.GET(req("GET", undefined, false))).status, 401); assert.equal(calls.length, before); });
await check("API returns private no-store reports with server profile identity", async () => { const res = await handlers.GET(req()); assert.equal(res.status, 200); assert.match(res.headers.get("cache-control") || "", /private, no-store/); assert.equal((await res.json()).profileId, owner); });
await check("API rejects cross-origin mutations and unknown actions", async () => { const cross = req("POST", { action: "review", ...reviewBody }); cross.headers.set("origin", "https://other.invalid"); assert.equal((await handlers.POST(cross)).status, 403); assert.equal((await handlers.POST(req("POST", { action: "delete-everything" }))).status, 400); });
await check("API gives a clear missing migration error", async () => { failure = "missing"; const res = await handlers.GET(req()); assert.equal(res.status, 503); assert.match((await res.json()).error, /migration/); });
console.log(`Study service/API: ${passed} checks passed with mocked transport.`);
