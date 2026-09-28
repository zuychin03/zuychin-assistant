import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { resumeRequestError } from "../src/lib/ai/agent/resume-scope";
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://resume.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture", GEMINI_API_KEY: "fixture", AUTH_SESSION_SECRET: "fixture", CHAT_API_KEY: "fixture" });
const owner = "11111111-1111-4111-8111-111111111111", parent = "22222222-2222-4222-8222-222222222222", child = "33333333-3333-4333-8333-333333333333", runId = "44444444-4444-4444-8444-444444444444", rootId = "55555555-5555-4555-8555-555555555555";
const runConversation = parent;
let runOwner = owner, rootConversation = parent, inserted = 0, queries = 0;
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); assert.equal(url.hostname, "resume.invalid"); queries++;
    const table = url.pathname.split("/").at(-1);
    if (table === "user_profiles") return Response.json({ id: owner, preferences: {} });
    if (table === "conversations") return Response.json(url.searchParams.get("user_profile_id") === `eq.${owner}` ? { id: url.searchParams.get("id")?.slice(3) } : null);
    if (table === "agent_runs") {
        if (init?.method === "POST") { inserted++; const body = JSON.parse(String(init.body)); assert.equal(body.root_run_id, rootId); return Response.json({ id: "66666666-6666-4666-8666-666666666666", root_run_id: rootId }); }
        const id = url.searchParams.get("id")?.slice(3), conversation = id === rootId ? rootConversation : runConversation;
        if (url.searchParams.get("user_profile_id") !== `eq.${runOwner}` || url.searchParams.get("conversation_id") !== `eq.${conversation}`) return Response.json(null);
        return Response.json({ id, root_run_id: rootId, conversation_id: conversation, user_profile_id: runOwner, status: "timeout", message: "Private previous task", plan: [], events: [], usage: {}, started_at: "2026-09-28T00:00:00Z" });
    }
    throw new Error(`Unexpected resume operation ${table}`);
};
const { getScopedResumeRun, createAgentRun } = await import("../src/lib/ai/agent/run-store");
const { ragChat } = await import("../src/lib/ai/rag-service");
assert.ok(resumeRequestError({ resumeRunId: "bad", conversationId: child, agent: true }));
assert.ok(resumeRequestError({ resumeRunId: runId, conversationId: child, agent: false }));
assert.equal(resumeRequestError({ resumeRunId: runId, conversationId: parent, agent: true }), null);
await assert.rejects(getScopedResumeRun(runId, { conversationId: child, userProfileId: owner }), /scope/);
await assert.rejects(ragChat({ channel: "web", message: "Resume", conversationId: child, resumeRunId: runId, agent: true }), /scope/);
assert.equal(inserted, 0);
runOwner = rootId;
await assert.rejects(getScopedResumeRun(runId, { conversationId: parent, userProfileId: owner }), /scope/);
await assert.rejects(createAgentRun({ message: "Resume", model: "fixture", conversationId: parent, userProfileId: owner, resumeRunId: runId }), /scope/);
runOwner = owner;
assert.equal((await getScopedResumeRun(runId, { conversationId: parent, userProfileId: owner })).message, "Private previous task");
rootConversation = child;
await assert.rejects(createAgentRun({ message: "Resume", model: "fixture", conversationId: parent, userProfileId: owner, resumeRunId: runId }), /scope/);
assert.equal(inserted, 0); rootConversation = parent;
assert.equal((await createAgentRun({ message: "Resume", model: "fixture", conversationId: parent, userProfileId: owner, resumeRunId: runId }))?.rootRunId, rootId);
assert.equal(inserted, 1);
const http = await import("../src/app/api/chat/route"), stream = await import("../src/app/api/chat/stream/route");
const request = (resumeRunId: string, conversationId: string) => new NextRequest("https://resume.invalid/api/chat", { method: "POST", headers: { authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ message: "Resume", channel: "web", agent: true, conversationId, resumeRunId }) });
const before = queries;
assert.equal((await http.POST(request("bad", child))).status, 400);
assert.equal((await stream.POST(request("bad", child))).status, 400);
assert.equal(queries, before);
assert.equal((await http.POST(request(runId, child))).status, 404);
const sse = await stream.POST(request(runId, child)); assert.match(await sse.text(), /scope/); assert.equal(inserted, 1);
console.log("Resume scope: malformed request, parent/foreign run, poisoned lineage, valid same-conversation resume and HTTP/SSE boundaries passed; mocked transport only.");
