import assert from "node:assert/strict";
import { confirmedActionReceipt, gateUnattendedTool, recordUnattendedContext, recordUnattendedSource, withUnattendedRun, isUnattendedRun } from "../src/lib/tasks/unattended-policy";

let checks = 0;
async function check(name: string, fn: () => unknown) { await fn(); checks++; console.log(`PASS ${name}`); }
await check("only explicit matching success receipts confirm an action", () => {
    for (const receipt of ["The second-brain vault is not configured.", "Vault write failed - nothing was committed.", "No page found at wiki/sources/a.md - nothing was deleted.", "vault_delete only removes wiki pages.", "Verification failed", "", "Unknown action: x", "✅ Email sent to a@example.invalid!"]) assert.equal(confirmedActionReceipt("vault_write", {}, receipt), false);
    assert.equal(confirmedActionReceipt("send_email", {}, "✅ Email sent to a@example.invalid!\nSubject: Test"), true);
    assert.equal(confirmedActionReceipt("vault_write", {}, "Updated wiki/sources/test.md (commit abc1234). Index and log updated."), true);
    assert.equal(confirmedActionReceipt("manage_todo_list", { action: "delete" }, "🗑️ Task deleted."), true);
    assert.equal(confirmedActionReceipt("manage_todo_list", { action: "delete" }, "✅ Task marked as done!"), false);
    assert.equal(confirmedActionReceipt("vault_lint", {}, "All good"), false);
});
await check("unattended context includes initial retrieval and explicit list reads", async () => {
    assert.equal(isUnattendedRun(), false);
    await withUnattendedRun({ runId: "run", taskId: "task", taskTitle: "Fixture", instruction: "Review sources", userProfileId: "owner" }, async () => {
        assert.equal(isUnattendedRun(), true);
        recordUnattendedContext("Initial knowledge", "[Knowledge: wiki/sources/test.md] Evidence");
        recordUnattendedSource("manage_notes", "Saved note excerpt", { action: "list" });
        recordUnattendedSource("manage_notes", "Mutation result must not be a source", { action: "delete" });
        await gateUnattendedTool("send_email", {}, async action => {
            assert.match(action.sourceContext, /wiki\/sources\/test.md/);
            assert.match(action.sourceContext, /Saved note excerpt/);
            assert.doesNotMatch(action.sourceContext, /Mutation result/);
            return { id: "approval", status: "pending" };
        });
    });
    assert.equal(isUnattendedRun(), false);
});
Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://scheduled-safety.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-paid", NVIDIA_NIM_API_KEY: "fixture-nim", AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat",
    TELEGRAM_BOT_TOKEN: "fixture-telegram", TELEGRAM_CHAT_ID: "1001", DISCORD_BOT_TOKEN: "fixture-discord", GITHUB_VAULT_TOKEN: "", GITHUB_VAULT_REPO: "", KNOWLEDGE_EMBEDDING_MODEL: "",
});
const owner = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const approvalId = "44444444-4444-4444-8444-444444444444";
const profile = { id: owner, display_name: "Fixture", system_prompt: "Fixture assistant", preferences: {} };
const taskRow = { id: taskId, user_profile_id: owner, title: "Fixture task", instruction: "Prepare a file", schedule_type: "recurring" as const, cron: "0 8 * * *", run_at: null, timezone: "Australia/Sydney", channel: "telegram" as const, conversation_id: null, agent_mode: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, last_result: null, created_at: new Date().toISOString() };
const callLog: { path: string; method: string; body: Record<string, unknown>; query: URLSearchParams }[] = [];
let runStatus = "running";
let expireFailure = false;
let attachmentFailure = false;
let textFailure = false;
let missingArtifact = false;
let generateArtifact = false;
let generatedCalls = 0;
let approveClaimed = true;
let saveReceipt = true;
let invalidHash = false;
let claimFailure = false;
let deliveryClaim = true;
let runFinishAllowed = true;
const approvedTool = "vault_write";
const approvedArgs: Record<string, unknown> = { path: "wiki/sources/fixture.md", markdown: "# Fixture" };
let proposedSources = "";
let artifactRow: Record<string, unknown> | null = null;
const { canonicalAction } = await import("../src/lib/tasks/unattended-policy");
globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req?.url ?? String(input));
    const method = init?.method ?? req?.method ?? "GET";
    const headers = new Headers(init?.headers ?? req?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    callLog.push({ path: url.pathname, method, body, query: url.searchParams });
    if (url.hostname === "scheduled-safety.supabase.co") {
        const endpoint = url.pathname.replace("/rest/v1/", "");
        if (method === "HEAD") return new Response(null, { headers: { "Content-Range": "*/0" } });
        if (endpoint === "rpc/assistant_start_task_run") return Response.json(true);
        if (endpoint === "rpc/assistant_claim_task_delivery") return Response.json(deliveryClaim);
        if (endpoint === "rpc/assistant_finish_task_run") { if (runFinishAllowed) runStatus = String(body.p_status); return Response.json(runFinishAllowed); }
        if (endpoint === "rpc/assistant_claim_task_run") return claimFailure ? Response.json({ message: "RPC missing", code: "PGRST202" }, { status: 404 }) : Response.json({ status: "reused", run: { id: runId, task_id: taskId, task_title: taskRow.title, user_profile_id: owner, task_snapshot: taskRow, trigger: "manual", status: "running", started_at: new Date().toISOString(), finished_at: null, detail: null } });
        if (endpoint === "rpc/assistant_finish_action") return Response.json(saveReceipt);
        if (endpoint === "rpc/assistant_propose_action") { proposedSources = String(body.p_sources); return Response.json({ id: approvalId, status: "pending" }); }
        if (endpoint === "rpc/assistant_decide_action") return claimFailure ? Response.json({ message: "RPC missing", code: "PGRST202" }, { status: 404 }) : Response.json({ claimed: approveClaimed, approval: { id: approvalId, task_id: taskId, run_id: runId, user_profile_id: owner, task_title: "Fixture task", tool: approvedTool, args: approvedArgs, args_hash: invalidHash ? "0".repeat(64) : canonicalAction(approvedTool, approvedArgs).hash, instruction: "Fixture instruction", source_context: "Fixture source", status: approveClaimed ? "executing" : "succeeded", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), decided_at: new Date().toISOString(), execution_token: runId, receipt: null } });
        if (endpoint === "rpc/match_embeddings") return Response.json([{ id: "memory-1", content: "Initial retrieved fixture evidence", metadata: { source: "note" }, similarity: 0.95 }]);
        if (endpoint.startsWith("rpc/")) return Response.json([]);
        if (endpoint === "user_profiles") return Response.json(profile);
        if (endpoint === "scheduled_tasks") return Response.json(method === "GET" ? [taskRow] : null);
        if (endpoint === "assistant_task_runs") {
            if (method === "PATCH") {
                if (body.status === "interrupted") {
                    assert.equal(url.searchParams.get("status"), "eq.running");
                    assert.equal(url.searchParams.get("user_profile_id"), `eq.${owner}`);
                    assert.match(url.searchParams.get("expires_at") || "", /^lte\./);
                    if (expireFailure) return Response.json({ message: "Fixture unavailable" }, { status: 503 });
                }
                runStatus = String(body.status); return Response.json(null);
            }
            return Response.json([{ id: runId, task_id: taskId, task_title: "Fixture", trigger: "manual", status: runStatus, started_at: new Date().toISOString(), finished_at: runStatus === "interrupted" ? new Date().toISOString() : null, detail: null }]);
        }
        if (endpoint === "assistant_action_approvals") return Response.json(method === "GET" ? [] : null);
        if (endpoint === "artifacts") {
            if (method === "POST") { artifactRow = { ...body, id: approvalId }; return Response.json({ id: approvalId }); }
            if (method === "GET") return Response.json(missingArtifact ? null : artifactRow);
            return Response.json(null);
        }
        if (endpoint === "embeddings" && method === "GET") return Response.json([{ id: "note-1", content: "Listed note evidence", metadata: { source: "mcp_save_note" }, created_at: new Date().toISOString() }]);
        if ((headers.get("Accept") || "").includes("vnd.pgrst.object+json")) return Response.json({ id: runId });
        return Response.json([]);
    }
    if (url.hostname === "integrate.api.nvidia.com" && url.pathname.endsWith("/embeddings")) return Response.json({ data: [{ embedding: Array(2048).fill(0.1) }] });
    if (url.hostname === "generativelanguage.googleapis.com") {
        generatedCalls++;
        const parts = generateArtifact && !JSON.stringify(body).includes("functionResponse") ? [{ functionCall: { name: "create_code_file", args: { filename: "fixture.txt", content: "Fixture artifact" } } }] : [{ text: "Fixture finished" }];
        const payload = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
        return url.pathname.includes("streamGenerateContent") ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }) : Response.json(payload);
    }
    if (url.hostname === "api.telegram.org") {
        if (textFailure && url.pathname.endsWith("/sendMessage")) return Response.json({ ok: false, description: "Synthetic ambiguous provider error" }, { status: 500 });
        const failed = attachmentFailure && url.pathname.endsWith("/sendDocument");
        return Response.json({ ok: !failed, result: { message_id: 1 }, description: "Synthetic attachment rejected" }, { status: failed ? 400 : 200 });
    }
    throw new Error(`Unexpected request blocked: ${url.hostname}${url.pathname}`);
};

const { taskInput } = await import("../src/lib/tasks/http");
const { mapScheduledTask } = await import("../src/lib/tasks/store");
const { taskReport } = await import("../src/lib/tasks/run-store");
const { runScheduledTask } = await import("../src/lib/tasks/runner");
const { ragChat, buildRagContext } = await import("../src/lib/ai/rag-service");
const { executeTool } = await import("../src/lib/ai/mcp-service");
const { POST: approvalPost } = await import("../src/app/api/tasks/approvals/route");
const { POST: runPost } = await import("../src/app/api/tasks/run/route");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
const { NextRequest } = await import("next/server");
const session = await createSessionValue();
const approveRequest = (cookie = true) => new NextRequest("https://fixture.invalid/api/tasks/approvals", { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { cookie: `${AUTH_COOKIE}=${session}` } : { authorization: "Bearer fixture-chat" }) }, body: JSON.stringify({ id: approvalId, decision: "approve" }) });
const runRequest = () => new NextRequest("https://fixture.invalid/api/tasks/run", { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer fixture-chat" }, body: JSON.stringify({ id: taskId, requestId: approvalId }) });

await check("past one-off metadata edits preserve the original instant but cannot re-enable it", () => {
    const task = { ...mapScheduledTask(taskRow), scheduleType: "once" as const, runAt: "2020-01-01T00:00:00.000Z", cron: null, enabled: false };
    assert.equal(taskInput({ title: "Edited", runAt: task.runAt }, task).runAt, task.runAt);
    assert.throws(() => taskInput({ runAt: "2020-01-02T00:00:00Z" }, task), /future/);
    assert.throws(() => taskInput({ enabled: true }, task), /future/);
});
await check("report reconciles expired running records with owner/status/expiry predicates", async () => {
    const report = await taskReport(owner);
    assert.equal(report.runs[0].status, "interrupted");
    assert.equal(report.activationError, undefined);
});
await check("failed run reconciliation blocks execution in the report", async () => {
    expireFailure = true;
    assert.match((await taskReport(owner)).activationError || "", /unavailable/);
    expireFailure = false;
});
await check("actual scheduled model commands refuse before profile writes or model calls", async () => {
    const start = callLog.length;
    for (const message of ["/model gemini x", "/embed-model nvidia y", "!model@bot list"]) await assert.rejects(ragChat({ message, channel: "telegram", paidOnly: true }), /cannot change model preferences/);
    assert.equal(callLog.length, start);
});
await check("actual initial RAG and list-tool evidence reaches an approval proposal", async () => {
    await withUnattendedRun({ runId, taskId, taskTitle: "Fixture", instruction: "Review", userProfileId: owner }, async () => {
        await buildRagContext({ message: "fixture evidence", channel: "telegram", thinking: false, search: false, paidOnly: true, profile: { id: owner, displayName: "Fixture", systemPrompt: "Fixture", preferences: {} } });
        await executeTool("manage_notes", { action: "list" });
        await executeTool("send_email", { to: "fixture@example.invalid", subject: "Review", body: "Fixture" });
    });
    assert.match(proposedSources, /Initial retrieved fixture evidence/);
    assert.match(proposedSources, /Listed note evidence/);
    assert.ok(proposedSources.length <= 16000);
});
await check("approval route rejects bearer-only authority", async () => {
    const before = callLog.length;
    assert.equal((await approvalPost(approveRequest(false))).status, 401);
    assert.equal(callLog.length, before);
});
await check("approval route rejects cross-origin cookie requests", async () => {
    const req = approveRequest(); req.headers.set("origin", "https://other.invalid");
    const before = callLog.length;
    assert.equal((await approvalPost(req)).status, 403);
    assert.equal(callLog.length, before);
});
await check("approval route refuses caller-supplied argument replacements", async () => {
    const req = new NextRequest("https://fixture.invalid/api/tasks/approvals", { method: "POST", headers: { cookie: `${AUTH_COOKIE}=${session}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: approvalId, decision: "approve", args: { path: "changed" } }) });
    const before = callLog.length;
    assert.equal((await approvalPost(req)).status, 400);
    assert.equal(callLog.length, before);
});
await check("approval route invalid hash never reaches the tool", async () => {
    invalidHash = true;
    const before = callLog.length;
    const data = await (await approvalPost(approveRequest())).json();
    assert.equal(data.approval.status, "outcome_unknown");
    assert.match(data.approval.receipt, /could not be confirmed/);
    assert.ok(callLog.slice(before).every(call => call.path.endsWith("user_profiles") || call.path.endsWith("assistant_decide_action") || call.path.endsWith("assistant_finish_action")));
    invalidHash = false;
});
await check("missing claim migrations refuse approvals and manual runs before dispatch", async () => {
    claimFailure = true;
    const before = generatedCalls;
    assert.equal((await approvalPost(approveRequest())).status, 503);
    assert.equal((await runPost(runRequest())).status, 503);
    assert.equal(generatedCalls, before);
    claimFailure = false;
});
await check("actual run endpoint reuses an existing durable request without another generation", async () => {
    const before = generatedCalls;
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await runPost(runRequest());
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { runId, status: "reused" });
    }
    assert.equal(generatedCalls, before);
});
await check("actual failed vault action remains unknown instead of succeeded", async () => {
    const response = await approvalPost(approveRequest());
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.approval.status, "outcome_unknown");
    assert.match(data.approval.receipt, /not configured/);
    assert.equal(callLog.filter(call => call.path.endsWith("assistant_finish_action")).at(-1)?.body.p_status, "outcome_unknown");
});
await check("already claimed approval cannot repeat tool execution", async () => {
    approveClaimed = false;
    const before = callLog.filter(call => call.path.endsWith("assistant_finish_action")).length;
    assert.equal((await approvalPost(approveRequest())).status, 409);
    assert.equal(callLog.filter(call => call.path.endsWith("assistant_finish_action")).length, before);
    approveClaimed = true;
});
await check("receipt persistence failure remains unknown and warns against repetition", async () => {
    saveReceipt = false;
    const data = await (await approvalPost(approveRequest())).json();
    assert.equal(data.approval.status, "outcome_unknown");
    assert.match(data.warning, /Do not repeat/);
    saveReceipt = true;
});
await check("actual runner marks rejected Telegram attachment delivery as error", async () => {
    generateArtifact = true; attachmentFailure = true;
    const result = await runScheduledTask(mapScheduledTask(taskRow), runId);
    assert.ok(generatedCalls > 0);
    assert.ok(callLog.some(call => call.path.endsWith("sendDocument")));
    assert.equal(result.status, "error");
    assert.match(result.detail, /delivery/);
    assert.equal(runStatus, "error");
});
await check("actual runner treats unavailable stored attachment as failed delivery", async () => {
    missingArtifact = true; attachmentFailure = false;
    const before = callLog.filter(call => call.path.endsWith("sendDocument")).length;
    assert.equal((await runScheduledTask(mapScheduledTask(taskRow), runId)).status, "error");
    assert.equal(callLog.filter(call => call.path.endsWith("sendDocument")).length, before);
    missingArtifact = false;
});
await check("actual runner records successful text and attachment delivery", async () => {
    assert.equal((await runScheduledTask(mapScheduledTask(taskRow), runId)).status, "ok");
    assert.equal(runStatus, "ok");
});
await check("late runner denied delivery cannot send or overwrite a newer result", async () => {
    deliveryClaim = false; runFinishAllowed = false; runStatus = "ok";
    const before = callLog.filter(call => call.path.endsWith("sendMessage") || call.path.endsWith("sendDocument")).length;
    const result = await runScheduledTask(mapScheduledTask(taskRow), runId);
    assert.equal(result.status, "error"); assert.match(result.detail, /no longer current/);
    assert.equal(callLog.filter(call => call.path.endsWith("sendMessage") || call.path.endsWith("sendDocument")).length, before);
    assert.equal(runStatus, "ok");
    assert.equal(callLog.some(call => call.path.endsWith("scheduled_tasks") && call.method === "PATCH"), false);
    deliveryClaim = true; runFinishAllowed = true;
});
await check("ambiguous scheduled text delivery is not retried through formatting fallback", async () => {
    textFailure = true;
    const before = callLog.filter(call => call.path.endsWith("sendMessage")).length;
    const attachments = callLog.filter(call => call.path.endsWith("sendDocument")).length;
    const result = await runScheduledTask(mapScheduledTask(taskRow), runId);
    assert.equal(result.status, "error"); assert.match(result.detail, /not fully confirmed/);
    assert.equal(callLog.filter(call => call.path.endsWith("sendMessage")).length, before + 1);
    assert.equal(callLog.filter(call => call.path.endsWith("sendDocument")).length, attachments);
    textFailure = false;
});
await check("late finish after delivery cannot overwrite latest run and reports uncertainty", async () => {
    runFinishAllowed = false; runStatus = "error";
    const result = await runScheduledTask(mapScheduledTask(taskRow), runId);
    assert.equal(result.status, "error"); assert.match(result.detail, /Delivery outcome is unconfirmed/);
    assert.equal(runStatus, "error"); runFinishAllowed = true;
});
await check("run deadline cancels production generation and prevents delivery", async () => {
    const timeout = AbortSignal.timeout, before = generatedCalls;
    const deliveryBefore = callLog.filter(call => call.path.endsWith("assistant_claim_task_delivery")).length;
    AbortSignal.timeout = (milliseconds) => milliseconds === 4 * 60_000 ? AbortSignal.abort(new Error("Synthetic run deadline")) : timeout(milliseconds);
    try {
        const result = await runScheduledTask(mapScheduledTask(taskRow), runId);
        assert.equal(result.status, "error"); assert.match(result.detail, /Synthetic run deadline/);
        assert.equal(generatedCalls, before);
        assert.equal(callLog.filter(call => call.path.endsWith("assistant_claim_task_delivery")).length, deliveryBefore);
    } finally { AbortSignal.timeout = timeout; }
});
await check("aborted notification signals prevent transport and chunk dispatch", async () => {
    const { sendTelegramMessage, sendTelegramDocument } = await import("../src/lib/messaging/telegram-service");
    const { sendDiscordMessage } = await import("../src/lib/messaging/discord-service");
    const signal = AbortSignal.abort(new Error("Synthetic delivery deadline")), before = callLog.length;
    assert.equal(await sendTelegramMessage("1001", "x".repeat(5000), { signal }), false);
    assert.equal(await sendTelegramDocument("1001", { filename: "a.txt", mimeType: "text/plain", body: "test" }, signal), false);
    assert.equal(await sendDiscordMessage("fixture", "x".repeat(3000), signal), false);
    assert.equal(callLog.length, before);
});
console.log(`Scheduled safety: ${checks} checks passed; all network transport was mocked.`);
