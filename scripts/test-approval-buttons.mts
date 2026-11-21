import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { applyV7Base } from "./fixtures/v7-base.mts";
import { approvalRest, type RestState } from "./fixtures/approval-rest.mts";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://approvals-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_ORIGIN: "https://assistant.test", AUTH_SESSION_SECRET: "fixture-session",
    TELEGRAM_BOT_TOKEN: "fixture-bot", TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret", TELEGRAM_CHAT_ID: "1001",
    GEMINI_API_KEY: "fixture-gemini", GITHUB_VAULT_TOKEN: "", GITHUB_VAULT_REPO: "", KNOWLEDGE_EMBEDDING_MODEL: "",
});
delete process.env.NEXT_PUBLIC_BASE_URL;

const OWNER = "11111111-1111-4111-8111-111111111111";
const migration = await readFile(new URL("./migrations/v7-channel-threads.sql", import.meta.url), "utf8");
const db = new PGlite();
await applyV7Base(db);
const value = async <T,>(sql: string, params: unknown[] = []) => (await db.query<{ value: T }>(sql, params)).rows[0]?.value;

// A scheduled task with a running run, so assistant_propose_action has something to attach to.
await db.query("insert into user_profiles (id) values ($1)", [OWNER]);
const TASK = (await db.query<{ id: string }>("insert into scheduled_tasks (user_profile_id, title, instruction, schedule_type, cron) values ($1, 'Weekly digest', 'Write the weekly digest page', 'recurring', '0 8 * * 1') returning id", [OWNER])).rows[0].id;
const RUN = (await db.query<{ id: string }>(`insert into assistant_task_runs (task_id, user_profile_id, request_id, task_title, task_snapshot, trigger)
    values ($1, $2, gen_random_uuid(), 'Weekly digest', jsonb_build_object('instruction', 'Write the weekly digest page'), 'manual') returning id`, [TASK, OWNER])).rows[0].id;

type Seen = { url: URL; method: string; body: string };
const seen: Seen[] = [];
const rest: RestState = { decideFails: false, proposeChatFails: false, noticesMissing: false, messages: [] };
const answerRest = approvalRest(db, OWNER, rest);
let telegramSendStatus = 200;
let nextMessageId = 500;

globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "";
    seen.push({ url, method, body });
    if (url.hostname === "approvals-fixture.supabase.co") return answerRest(url, method, body);
    if (url.hostname === "api.telegram.org") {
        if (url.pathname.endsWith("/sendMessage") && telegramSendStatus !== 200) return Response.json({ ok: false }, { status: telegramSendStatus });
        return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
    }
    throw new Error(`Unexpected offline request to ${url.href}`);
};

const { NextRequest } = await import("next/server");
const { canonicalAction } = await import("../src/lib/tasks/unattended-policy");
const notices = await import("../src/lib/tasks/approval-notices");
const { mapApproval } = await import("../src/lib/tasks/run-store");
const webhook = await import("../src/app/api/telegram/webhook/route");
const approvalsRoute = await import("../src/app/api/tasks/approvals/route");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    seen.length = 0;
    rest.decideFails = false;
    rest.noticesMissing = false;
    telegramSendStatus = 200;
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

const telegram = (method: string) => seen.filter(({ url }) => url.hostname === "api.telegram.org" && url.pathname.endsWith(`/${method}`)).map(({ body }) => JSON.parse(body));
const rpcCalls = (name: string) => seen.filter(({ url }) => url.pathname === `/rest/v1/rpc/${name}`);
const approvalRow = async (id: string) => (await db.query<{ status: string; receipt: string | null }>("select status, receipt from assistant_action_approvals where id = $1", [id])).rows[0];
const action = (args: Record<string, unknown>) => {
    const canonical = canonicalAction("vault_write", args);
    return { runId: RUN, taskId: TASK, taskTitle: "Weekly digest", instruction: "Write the weekly digest page", userProfileId: OWNER,
        tool: "vault_write", args: canonical.args, argsHash: canonical.hash, sourceContext: "" };
};
const tap = (id: string, choice: "a" | "r", messageId: number, from = 1001) => webhook.POST(new NextRequest("https://assistant.test/api/telegram/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "fixture-webhook-secret" },
    body: JSON.stringify({ callback_query: { id: `cb-${randomUUID()}`, data: `apr:${id}:${choice}`, from: { id: from }, message: { message_id: messageId, chat: { id: 1001 } } } }),
}));
const session = await createSessionValue();
const decideOnWeb = (id: string, decision: "approve" | "reject") => approvalsRoute.POST(new NextRequest("https://assistant.test/api/tasks/approvals", {
    method: "POST", headers: { "Content-Type": "application/json", cookie: `${AUTH_COOKIE}=${session}` }, body: JSON.stringify({ id, decision }),
}));
/** Proposes through the real gate path and returns the approval id and its notice's message id. */
async function proposed(args: Record<string, unknown>) {
    const proposal = await notices.proposeWithNotice(action(args));
    const notice = (await db.query<{ message_id: number }>("select message_id::int as message_id from assistant_approval_notices where approval_id = $1", [proposal.id])).rows[0];
    return { id: proposal.id, messageId: notice?.message_id };
}

const OLD = (await value<{ id: string }>("select public.assistant_propose_action($1, 'vault_write', $2, $3, '') as value", [RUN, { path: "wiki/old.md" }, canonicalAction("vault_write", { path: "wiki/old.md" }).hash])).id;

await check("the P4 migration applies twice over V6 approvals and keeps every existing row a scheduled one", async () => {
    await db.exec(migration);
    await db.exec(migration);
    assert.deepEqual((await db.query("select source, channel, conversation_id, turn_id from assistant_action_approvals where id = $1", [OLD])).rows[0],
        { source: "scheduled", channel: null, conversation_id: null, turn_id: null });
    const reach = await db.query<Record<string, boolean>>(`select
        has_table_privilege('anon', 'public.assistant_approval_notices', 'select') as anon,
        has_table_privilege('authenticated', 'public.assistant_approval_notices', 'insert') as authenticated,
        has_function_privilege('anon', 'public.assistant_decide_action(uuid, uuid, text)', 'execute') as anon_decide,
        has_function_privilege('service_role', 'public.assistant_decide_action(uuid, uuid, text)', 'execute') as service_decide`);
    assert.deepEqual(reach.rows[0], { anon: false, authenticated: false, anon_decide: false, service_decide: true });
});

await check("scheduled rows need a task and run; chat rows need a turn and channel; one chat action per turn", async () => {
    const insert = (columns: string, values: string) => db.query(`insert into assistant_action_approvals (user_profile_id, task_title, tool, args, args_hash, instruction, ${columns})
        values ('${OWNER}', 'Telegram chat', 'send_email', '{"to":"me@example.invalid"}', '${"a".repeat(64)}', 'Email me', ${values}) returning id`);
    await assert.rejects(insert("source", "'scheduled'"), /assistant_action_source_check/);
    await assert.rejects(insert("source, channel", "'chat', 'telegram'"), /assistant_action_source_check/);
    await assert.rejects(insert("source, turn_id, channel", "'chat', gen_random_uuid(), 'sms'"), /assistant_action_source_check/);
    const conversation = (await db.query<{ id: string }>("insert into conversations (title, channel) values ('Chat', 'telegram') returning id")).rows[0].id;
    const turn = randomUUID();
    const chat = (await insert("source, channel, turn_id, conversation_id", `'chat', 'telegram', '${turn}', '${conversation}'`)).rows[0] as { id: string };
    await assert.rejects(insert("source, channel, turn_id", `'chat', 'telegram', '${turn}'`), /assistant_action_chat_once/);

    for (const change of ["source = 'scheduled'", "channel = 'discord'", `turn_id = '${randomUUID()}'`]) {
        await assert.rejects(db.query(`update assistant_action_approvals set ${change} where id = $1`, [chat.id]), /immutable/);
    }
    const other = (await db.query<{ id: string }>("insert into conversations (title) values ('Other') returning id")).rows[0].id;
    await assert.rejects(db.query("update assistant_action_approvals set conversation_id = $1 where id = $2", [other, chat.id]), /immutable/);
    await db.query("delete from conversations where id = $1", [conversation]);
    assert.equal((await db.query<{ conversation_id: string | null }>("select conversation_id from assistant_action_approvals where id = $1", [chat.id])).rows[0].conversation_id, null,
        "deleting the conversation keeps the approval and clears the link");

    const decided = await value<{ claimed: boolean; approval: { status: string } }>("select public.assistant_decide_action($1, $2, 'reject') as value", [chat.id, OWNER]);
    assert.equal(decided.claimed, true, "a chat approval has no task row to lock and still decides");
    assert.equal(decided.approval.status, "rejected");
    assert.equal(await value("select public.assistant_decide_action($1, gen_random_uuid(), 'approve') as value", [OLD]), null, "still owner-only");
});

await check("the notice is plain text with the action's details, its expiry, and buttons that fit Telegram's limits", () => {
    const approval = mapApproval({ id: OLD, task_id: TASK, run_id: RUN, task_title: "Weekly digest", tool: "send_email", status: "pending", source: "scheduled",
        args: { body: `Hi *team*,\n${"x".repeat(900)}`, subject: "Digest_v2 [draft]", to: "me@example.invalid" }, expires_at: "2026-11-22T22:00:00Z", created_at: "2026-11-21T22:00:00Z" });
    const text = notices.approvalNoticeText(approval);
    assert.match(text, /^🔐 Approval needed\nFrom: Weekly digest\n\nSend an email\nTo: me@example\.invalid\nSubject: Digest_v2 \[draft\]\nBody: Hi \*team\*, x+…\n\nExpires 23\/11, 9:00 am AEDT\.$/);
    assert.ok(text.length < 1000);
    const keyboard = notices.approvalKeyboard(OLD);
    for (const button of keyboard.inline_keyboard.flat()) if ("callback_data" in button) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    assert.deepEqual(keyboard.inline_keyboard[1], [{ text: "Open", url: `https://assistant.test/tasks?approval=${OLD}` }]);
    process.env.AUTH_ORIGIN = "http://127.0.0.1:3000";
    try {
        assert.equal(notices.approvalKeyboard(OLD).inline_keyboard.length, 1, "Telegram refuses a loopback URL button, so it is left out");
    } finally {
        process.env.AUTH_ORIGIN = "https://assistant.test";
    }
    assert.ok(notices.APPROVAL_CALLBACK.test(`apr:${OLD}:a`));
    assert.ok(!notices.APPROVAL_CALLBACK.test(`apr:${OLD}:x`) && !notices.APPROVAL_CALLBACK.test(`apr:${OLD.toUpperCase()}:a`));
});

let first: { id: string; messageId: number };
await check("a new approval sends one notice with buttons; proposing the same action again sends nothing", async () => {
    first = await proposed({ path: "wiki/weekly.md", markdown: "# Weekly" });
    const sent = telegram("sendMessage");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chat_id, "1001");
    assert.equal(sent[0].parse_mode, undefined, "plain text, so argument values are not read as Markdown");
    assert.deepEqual(sent[0].reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data), [`apr:${first.id}:a`, `apr:${first.id}:r`]);
    assert.equal(typeof first.messageId, "number", "the message id is saved for later edits");
    seen.length = 0;
    const again = await notices.proposeWithNotice(action({ path: "wiki/weekly.md", markdown: "# Weekly" }));
    assert.equal(again.id, first.id);
    assert.equal(telegram("sendMessage").length, 0);
});

await check("a failed send frees the notice so a later proposal of the same action tries again", async () => {
    telegramSendStatus = 403;
    const failed = await proposed({ path: "wiki/retry.md" });
    assert.equal(failed.messageId, undefined);
    telegramSendStatus = 200;
    const retried = await proposed({ path: "wiki/retry.md" });
    assert.equal(retried.id, failed.id);
    assert.equal(typeof retried.messageId, "number");
});

await check("a tap from anyone but the owner reaches nothing", async () => {
    const res = await tap(first.id, "a", first.messageId, 2002);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, []);
    assert.equal((await approvalRow(first.id)).status, "pending");
});

await check("the owner's Approve runs the action once, records it and edits the notice without buttons", async () => {
    assert.equal((await tap(first.id, "a", first.messageId)).status, 200);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), ["Approving…"]);
    assert.equal(rpcCalls("assistant_finish_action").length, 1);
    const row = await approvalRow(first.id);
    assert.equal(row.status, "outcome_unknown", "the fixture vault is not configured, so no confirmed receipt");
    assert.match(row.receipt ?? "", /not configured/);
    const [edit] = telegram("editMessageText");
    assert.equal(edit.message_id, first.messageId);
    assert.equal(edit.reply_markup, undefined, "the keyboard is removed");
    assert.match(edit.text, /^🔐 Approval needed\nFrom: Weekly digest/);
    assert.match(edit.text, /\n\n⚠️ Approved, but the outcome is unknown\. Check the destination before trying again\.$/);
});

await check("a second tap says it is already decided and changes nothing", async () => {
    await tap(first.id, "a", first.messageId);
    await tap(first.id, "r", first.messageId);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), [
        "Already approved, but the outcome is unknown. Check Tasks.", "Already approved, but the outcome is unknown. Check Tasks."]);
    assert.equal(rpcCalls("assistant_finish_action").length, 0);
    assert.equal(telegram("editMessageText").length, 0, "only the decision that ran edits the notice");
});

await check("Reject records the decision, runs nothing and edits the notice", async () => {
    const rejected = await proposed({ path: "wiki/reject.md" });
    seen.length = 0;
    await tap(rejected.id, "r", rejected.messageId);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), ["Rejected."]);
    assert.deepEqual(await approvalRow(rejected.id), { status: "rejected", receipt: null });
    assert.equal(rpcCalls("assistant_finish_action").length, 0);
    assert.match(telegram("editMessageText")[0].text, /\n\n❌ Rejected\. Nothing was run\.$/);
});

await check("an expired approval cannot be approved, and its notice says so", async () => {
    const args = canonicalAction("vault_write", { path: "wiki/late.md" });
    const late = (await db.query<{ id: string }>(`insert into assistant_action_approvals (task_id, run_id, user_profile_id, task_title, tool, args, args_hash, instruction, expires_at)
        values ($1, $2, $3, 'Weekly digest', 'vault_write', $4, $5, 'Write it', now() - interval '1 minute') returning id`, [TASK, RUN, OWNER, args.args, args.hash])).rows[0].id;
    await db.query("insert into assistant_approval_notices (approval_id, channel, chat_id, message_id) values ($1, 'telegram', '1001', 777)", [late]);
    await tap(late, "a", 777);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), ["This approval has expired. Nothing was run."]);
    assert.equal((await approvalRow(late)).status, "expired");
    const [edit] = telegram("editMessageText");
    assert.equal(edit.message_id, 777);
    assert.match(edit.text, /\n\n⌛ Expired\. Nothing was run\.$/);
});

await check("a decision on the web edits the Telegram notice, and a later tap is refused", async () => {
    const web = await proposed({ path: "wiki/web.md" });
    seen.length = 0;
    const res = await decideOnWeb(web.id, "reject");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).approval.status, "rejected");
    const [edit] = telegram("editMessageText");
    assert.equal(edit.message_id, web.messageId);
    assert.match(edit.text, /❌ Rejected/);
    seen.length = 0;
    await tap(web.id, "a", web.messageId);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), ["Already rejected."]);
    assert.equal((await decideOnWeb(web.id, "approve")).status, 409);
});

await check("an unknown approval drops its buttons; a storage failure keeps them for a retry", async () => {
    await tap(randomUUID(), "a", 901);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), ["This approval is no longer available."]);
    assert.equal(telegram("editMessageReplyMarkup")[0].message_id, 901);
    seen.length = 0;
    const pending = await proposed({ path: "wiki/outage.md" });
    seen.length = 0;
    rest.decideFails = true;
    await tap(pending.id, "a", pending.messageId);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), ["Couldn't record that. Try again, or open Tasks."]);
    assert.equal(telegram("editMessageText").length + telegram("editMessageReplyMarkup").length, 0);
    assert.equal((await approvalRow(pending.id)).status, "pending");
});

await check("without the notices table, approvals still work and nothing is sent to Telegram", async () => {
    rest.noticesMissing = true;
    const quiet = await notices.proposeWithNotice(action({ path: "wiki/quiet.md" }));
    assert.equal(quiet.status, "pending");
    assert.equal(telegram("sendMessage").length, 0);
    const res = await decideOnWeb(quiet.id, "reject");
    assert.equal(res.status, 200);
    assert.equal(telegram("editMessageText").length, 0);
});

await db.close();
console.log(`Approval buttons: ${passed} checks passed; the approval SQL ran in PGlite behind a mocked Supabase REST layer, and Telegram was mocked.`);
