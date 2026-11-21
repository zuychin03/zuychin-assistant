import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { applyV7Base } from "./fixtures/v7-base.mts";
import { approvalRest, type RestState } from "./fixtures/approval-rest.mts";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://chat-approval-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_ORIGIN: "https://assistant.test", AUTH_SESSION_SECRET: "fixture-session",
    TELEGRAM_BOT_TOKEN: "fixture-bot", TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret", TELEGRAM_CHAT_ID: "1001",
    GEMINI_API_KEY: "fixture-gemini", GITHUB_VAULT_TOKEN: "", GITHUB_VAULT_REPO: "", KNOWLEDGE_EMBEDDING_MODEL: "",
});
// Without Google credentials the Gmail tool fails before any network call, so "sent" can never happen by accident.
for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "NEXT_PUBLIC_BASE_URL", "CHANNEL_QUIET_GAP_MINUTES"]) delete process.env[key];

const OWNER = "11111111-1111-4111-8111-111111111111";
const EMAIL = { to: "me@example.invalid", subject: "Test from Telegram", body: "Hello from the fixture." };
const db = new PGlite();
await applyV7Base(db);
await db.exec(await readFile(new URL("./migrations/v7-channel-threads.sql", import.meta.url), "utf8"));
await db.query("insert into user_profiles (id) values ($1)", [OWNER]);

type Seen = { url: URL; method: string; body: string };
const seen: Seen[] = [];
const rest: RestState = { decideFails: false, proposeChatFails: false, noticesMissing: false, messages: [] };
const answerRest = approvalRest(db, OWNER, rest);
let nextMessageId = 700;

function gemini(url: URL, body: string): Response {
    if (url.pathname.includes("embedContent") || url.pathname.includes("batchEmbedContents")) {
        const values = Array(768).fill(0.01);
        return Response.json(url.pathname.includes("batch") ? { embeddings: [{ values }] } : { embedding: { values } });
    }
    // Only the chat call offers tools; titles and memory extraction get plain text.
    const asksForEmail = body.includes("functionDeclarations") && !body.includes("functionResponse");
    const parts = asksForEmail ? [{ functionCall: { name: "send_email", args: EMAIL } }] : [{ text: "I asked for your approval in Telegram." }];
    const payload = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
    return url.pathname.includes("streamGenerateContent")
        ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
        : Response.json(payload);
}

globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "";
    seen.push({ url, method, body });
    if (url.hostname === "chat-approval-fixture.supabase.co") return answerRest(url, method, body);
    if (url.hostname === "api.telegram.org") return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
    if (url.hostname === "generativelanguage.googleapis.com") return gemini(url, body);
    throw new Error(`Unexpected offline request to ${url.href}`);
};

const { NextRequest } = await import("next/server");
const chat = await import("../src/lib/tasks/chat-approval");
const { executeTool } = await import("../src/lib/ai/mcp-service");
const { withApprovedAction, canonicalAction } = await import("../src/lib/tasks/unattended-policy");
const webhook = await import("../src/app/api/telegram/webhook/route");
const approvalsRoute = await import("../src/app/api/tasks/approvals/route");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    seen.length = 0;
    rest.messages.length = 0;
    rest.proposeChatFails = false;
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

const telegram = (method: string) => seen.filter(({ url }) => url.hostname === "api.telegram.org" && url.pathname.endsWith(`/${method}`)).map(({ body }) => JSON.parse(body));
const proposals = () => seen.filter(({ url }) => url.pathname === "/rest/v1/rpc/assistant_propose_chat_action");
const turn = (overrides: Partial<Parameters<typeof chat.withChatApprovals>[0]> = {}) => ({
    channel: "telegram" as const, conversationId: null, turnId: randomUUID(), instruction: "Email me a test", userProfileId: OWNER, ...overrides,
});
const chatRows = () => db.query<{ id: string; tool: string; status: string; channel: string; conversation_id: string | null; turn_id: string; task_title: string; instruction: string; minutes: number }>(
    "select id, tool, status, channel, conversation_id, turn_id, task_title, instruction, extract(epoch from expires_at - created_at)::int / 60 as minutes from assistant_action_approvals where source = 'chat' order by created_at");
const session = await createSessionValue();
const decideOnWeb = (id: string, decision: "approve" | "reject") => approvalsRoute.POST(new NextRequest("https://assistant.test/api/tasks/approvals", {
    method: "POST", headers: { "Content-Type": "application/json", cookie: `${AUTH_COOKIE}=${session}` }, body: JSON.stringify({ id, decision }),
}));
const telegramPost = (update: unknown) => webhook.POST(new NextRequest("https://assistant.test/api/telegram/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "fixture-webhook-secret" }, body: JSON.stringify(update),
}));
const tap = (id: string, choice: "a" | "r", messageId: number) => telegramPost({
    callback_query: { id: `cb-${randomUUID()}`, data: `apr:${id}:${choice}`, from: { id: 1001 }, message: { message_id: messageId, chat: { id: 1001 } } },
});

await check("only email and calendar changes wait; reads, drafts and in-app writes do not", () => {
    assert.equal(chat.chatSendNeedsApproval("send_email", EMAIL), true);
    assert.equal(chat.chatSendNeedsApproval("manage_calendar_event", { action: "create", summary: "Dentist" }), true);
    assert.equal(chat.chatSendNeedsApproval("manage_calendar_event", { action: "delete", event_id: "e1" }), true);
    for (const [tool, args] of [["list_calendar_events", {}], ["manage_calendar_event", { action: "list" }], ["draft_gmail_reply", {}], ["save_note", {}], ["manage_todo_list", { action: "add" }], ["read_email", {}]] as const) {
        assert.equal(chat.chatSendNeedsApproval(tool, args), false, tool);
    }
});

await check("outside a Telegram turn the tool runs as before", async () => {
    const result = await executeTool("send_email", EMAIL);
    assert.match(result, /Failed to send email/, "it reached the Gmail tool, which has no fixture credentials");
    assert.equal(proposals().length, 0);
});

await check("in a Telegram turn an email waits: one approval for an hour, one notice, nothing sent", async () => {
    const t = turn();
    const first = await chat.withChatApprovals(t, () => executeTool("send_email", EMAIL));
    const again = await chat.withChatApprovals(t, () => executeTool("send_email", { ...EMAIL }));
    assert.match(first, /^Waiting for the owner's approval in Telegram \(buttons sent; expires in 1 hour\)\. Nothing has been sent yet\./);
    assert.equal(again, first, "asking twice in one turn reuses the approval");
    const rows = (await chatRows()).rows.filter((row) => row.turn_id === t.turnId);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], id: undefined, turn_id: undefined }, { id: undefined, turn_id: undefined, tool: "send_email", status: "pending", channel: "telegram",
        conversation_id: null, task_title: "Telegram chat", instruction: "Email me a test", minutes: 60 });
    const notices = telegram("sendMessage");
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /^🔐 Approval needed\nFrom: Telegram chat\n\nSend an email\nTo: me@example\.invalid\nSubject: Test from Telegram\nBody: Hello from the fixture\./);
    assert.deepEqual(notices[0].reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data), [`apr:${rows[0].id}:a`, `apr:${rows[0].id}:r`]);

    seen.length = 0;
    await chat.withChatApprovals(turn(), () => executeTool("send_email", EMAIL));
    assert.equal(proposals().length, 1, "a later turn asks again rather than reusing an old approval");
});

await check("an approved action runs under its permit even inside a chat turn, and is not held again", async () => {
    const hash = canonicalAction("send_email", EMAIL).hash;
    const result = await chat.withChatApprovals(turn(), () => withApprovedAction({ runId: "", taskId: "", taskTitle: "Telegram chat", instruction: "x", userProfileId: OWNER, tool: "send_email", argsHash: hash },
        () => executeTool("send_email", EMAIL)));
    assert.match(result, /Failed to send email/);
    assert.equal(proposals().length, 0);
});

await check("without a confirmed owner or with storage down, the send is refused, never run", async () => {
    assert.equal(await chat.withChatApprovals(turn({ userProfileId: null }), () => executeTool("send_email", EMAIL)), "This chat has no confirmed owner, so the action was not sent.");
    rest.proposeChatFails = true;
    assert.match(await chat.withChatApprovals(turn(), () => executeTool("send_email", EMAIL)), /^The approval could not be recorded safely, so the action was not sent\./);
    assert.equal(telegram("sendMessage").length, 0);
});

let held: { id: string; conversation: string; messageId: number };
await check("a real Telegram turn that asks to email holds the send and tells the model so", async () => {
    const res = await telegramPost({ message: { message_id: 40, chat: { id: 1001 }, from: { id: 1001 }, text: "Email me a test" } });
    assert.equal(res.status, 200);
    const thread = (await db.query<{ conversation_id: string }>("select conversation_id from assistant_channel_threads where channel = 'telegram' and chat_key = '1001'")).rows[0];
    const row = (await chatRows()).rows.find((r) => r.conversation_id === thread.conversation_id);
    assert.ok(row, "the approval is linked to the chat's conversation");
    assert.equal(row.instruction, "Email me a test");
    assert.equal(row.status, "pending");
    const followUp = seen.find(({ url, body }) => url.hostname === "generativelanguage.googleapis.com" && body.includes("functionResponse"));
    assert.match(followUp?.body ?? "", /Waiting for the owner's approval in Telegram/, "the model got the hold message, not a send result");
    assert.doesNotMatch(followUp?.body ?? "", /Failed to send email|Email sent/);
    const sent = telegram("sendMessage");
    assert.equal(sent.filter((m) => m.reply_markup).length, 1, "one notice with buttons");
    assert.ok(sent.some((m) => /I asked for your approval in Telegram/.test(m.text)), "then the model's reply");
    const notice = (await db.query<{ message_id: number }>("select message_id::int as message_id from assistant_approval_notices where approval_id = $1", [row.id])).rows[0];
    held = { id: row.id, conversation: thread.conversation_id, messageId: notice.message_id };
});

await check("Approve runs the send once and saves the outcome into the conversation", async () => {
    await tap(held.id, "a", held.messageId);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), ["Approving…"]);
    assert.equal(seen.filter(({ url }) => url.pathname === "/rest/v1/rpc/assistant_finish_action").length, 1);
    assert.equal((await db.query<{ status: string }>("select status from assistant_action_approvals where id = $1", [held.id])).rows[0].status, "outcome_unknown");
    assert.match(telegram("editMessageText")[0].text, /⚠️ Approved, but the outcome is unknown/);
    const [saved] = rest.messages;
    assert.equal(rest.messages.length, 1);
    assert.equal(saved.role, "assistant");
    assert.equal(saved.channel, "telegram");
    assert.equal(saved.conversation_id, held.conversation);
    assert.match(String(saved.content), /^Send an email: ⚠️ Approved, but the outcome is unknown\./);
    assert.deepEqual(saved.metadata, { source: "chat_approval", approvalId: held.id });

    seen.length = 0;
    rest.messages.length = 0;
    await tap(held.id, "a", held.messageId);
    assert.equal(seen.filter(({ url }) => url.pathname === "/rest/v1/rpc/assistant_finish_action").length, 0, "a second tap never sends again");
    assert.equal(rest.messages.length, 0);
});

await check("a rejection on the web is saved into the conversation too", async () => {
    const t = turn({ conversationId: held.conversation });
    await chat.withChatApprovals(t, () => executeTool("manage_calendar_event", { action: "create", summary: "Dentist", start: "2026-11-24T09:00:00+11:00" }));
    const row = (await chatRows()).rows.find((r) => r.turn_id === t.turnId)!;
    seen.length = 0;
    const res = await decideOnWeb(row.id, "reject");
    assert.equal(res.status, 200);
    assert.equal(rest.messages.length, 1);
    assert.equal(rest.messages[0].content, "Change the calendar: ❌ Rejected. Nothing was run.");
    assert.match(telegram("editMessageText")[0].text, /\nSummary: Dentist\n[\s\S]*❌ Rejected/);
});

await check("an hour later the approval has expired; a tap says so and the conversation records it", async () => {
    const t = turn({ conversationId: held.conversation });
    await chat.withChatApprovals(t, () => executeTool("send_email", { ...EMAIL, subject: "Late" }));
    const row = (await chatRows()).rows.find((r) => r.turn_id === t.turnId)!;
    // expires_at is frozen by the immutability trigger, so the test moves the clock by disabling it for one statement.
    await db.exec("alter table assistant_action_approvals disable trigger assistant_action_payload_immutable");
    await db.query("update assistant_action_approvals set created_at = created_at - interval '61 minutes', expires_at = expires_at - interval '61 minutes' where id = $1", [row.id]);
    await db.exec("alter table assistant_action_approvals enable trigger assistant_action_payload_immutable");
    const notice = (await db.query<{ message_id: number }>("select message_id::int as message_id from assistant_approval_notices where approval_id = $1", [row.id])).rows[0];
    seen.length = 0;
    await tap(row.id, "a", notice.message_id);
    assert.deepEqual(telegram("answerCallbackQuery").map((b) => b.text), ["This approval has expired. Nothing was run."]);
    assert.equal(rest.messages[0]?.content, "Send an email: ⌛ Expired. Nothing was run.");
    assert.equal(seen.filter(({ url }) => url.pathname === "/rest/v1/rpc/assistant_finish_action").length, 0);
});

await db.close();
console.log(`Chat approval: ${passed} checks passed; the approval SQL ran in PGlite, and Telegram, Gemini and Supabase REST were mocked. No email could be sent (no Google credentials).`);
