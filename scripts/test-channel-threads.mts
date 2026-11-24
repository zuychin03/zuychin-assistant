import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { applyV7Base } from "./fixtures/v7-base.mts";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://threads-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_ORIGIN: "https://assistant.test",
    TELEGRAM_BOT_TOKEN: "fixture-bot", TELEGRAM_CHAT_ID: "1001", GEMINI_API_KEY: "fixture-gemini",
});
delete process.env.CHANNEL_QUIET_GAP_MINUTES;

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const migration = await readFile(new URL("./migrations/v7-channel-threads.sql", import.meta.url), "utf8");
const db = new PGlite();
await applyV7Base(db);

type Seen = { url: URL; method: string; body: string };
const seen: Seen[] = [];
let rpcMissing = false;
let channelColumn = true;
let conversationChannel = "telegram";
let telegramStatus = 200;
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "";
    const accept = new Headers(init?.headers ?? request?.headers).get("Accept") ?? "";
    seen.push({ url, method, body });
    if (url.hostname === "api.telegram.org") {
        return Response.json(telegramStatus === 200 ? { ok: true, result: { message_id: 9 } } : { ok: false }, { status: telegramStatus });
    }
    if (url.hostname !== "threads-fixture.supabase.co") throw new Error(`Unexpected offline request to ${url.href}`);
    if (url.pathname === "/rest/v1/rpc/assistant_channel_thread") {
        if (rpcMissing) return Response.json({ code: "PGRST202", message: "Could not find the function", details: null, hint: null }, { status: 404 });
        const a = JSON.parse(body);
        const { rows } = await db.query<{ id: string }>("select public.assistant_channel_thread($1, $2, $3::uuid, $4::integer, $5::boolean) as id",
            [a.p_channel, a.p_chat_key, a.p_profile, a.p_gap_seconds, a.p_force_new]);
        return Response.json(rows[0].id);
    }
    if (url.pathname === "/rest/v1/user_profiles") return Response.json([{ id: OWNER, display_name: "Owner", system_prompt: null, preferences: {} }]);
    if (url.pathname === "/rest/v1/messages" && method === "POST") {
        const row = { id: "88888888-8888-4888-8888-888888888888" };
        return Response.json(accept.includes("object") ? row : [row], { status: 201 });
    }
    if (url.pathname === "/rest/v1/conversations" && method === "GET") {
        if (!channelColumn && url.searchParams.get("select")?.includes("channel")) {
            return Response.json({ code: "42703", message: "column conversations.channel does not exist", details: null, hint: null }, { status: 400 });
        }
        const row = { id: "conv-x", title: "From Telegram", updated_at: "2026-11-21T00:00:00Z", created_at: "2026-11-21T00:00:00Z", project_id: null, ...(channelColumn ? { channel: conversationChannel } : {}) };
        return Response.json(accept.includes("object") ? row : [row]);
    }
    return Response.json([]);
};

const { NextRequest } = await import("next/server");
const threads = await import("../src/lib/messaging/channel-threads");
const { notify } = await import("../src/lib/messaging/router");
const { setTelegramCommands } = await import("../src/lib/messaging/telegram-service");
const { listConversations, getConversation } = await import("../src/lib/db");
const stream = await import("../src/app/api/chat/stream/route");
const chat = await import("../src/app/api/chat/route");

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    seen.length = 0;
    rpcMissing = false;
    channelColumn = true;
    conversationChannel = "telegram";
    telegramStatus = 200;
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

const owner = async () => ({ id: OWNER });
const turn = (message: string, chatKey = "1001", channel: "telegram" | "discord" = "telegram") => threads.channelTurn(channel, chatKey, message, { profile: owner });
const idOf = (t: Awaited<ReturnType<typeof turn>>) => t.kind === "help" ? null : t.conversationId;
const savedMessages = () => seen.filter(({ url, method }) => url.pathname === "/rest/v1/messages" && method === "POST").map(({ body }) => JSON.parse(body));
const age = (chatKey: string, hours: number) => db.query(`update public.assistant_channel_threads set last_activity_at = now() - make_interval(hours => ${hours}) where chat_key = $1`, [chatKey]);

await check("the migration refuses to run before the base setup", async () => {
    const bare = new PGlite();
    try {
        await assert.rejects(bare.exec(migration), /Run supabase-setup\.sql before v7-channel-threads\.sql/);
    } finally {
        await bare.close();
    }
});

await check("the migration applies twice, is embedded verbatim, marks old conversations web, and stays server-only", async () => {
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    assert.ok(setup.includes(`-- ===== V7 channel threads =====\n-- v7-channel-threads.sql\n${migration.trimEnd()}`));
    await db.query("insert into public.user_profiles (id) values ($1), ($2)", [OWNER, OTHER]);
    const before = await db.query<{ id: string }>("insert into public.conversations (title) values ('Old web chat') returning id");
    await db.exec(migration);
    await db.exec(migration);
    const old = await db.query<{ channel: string }>("select channel from public.conversations where id = $1", [before.rows[0].id]);
    assert.equal(old.rows[0].channel, "web");
    await assert.rejects(db.query("insert into public.conversations (title, channel) values ('x', 'sms')"), /conversations_channel_check/);
    const reach = await db.query<Record<string, boolean>>(`select
        has_table_privilege('anon', 'public.assistant_channel_threads', 'select') as anon_table,
        has_table_privilege('authenticated', 'public.assistant_channel_threads', 'update') as user_table,
        has_function_privilege('anon', 'public.assistant_channel_thread(text, text, uuid, integer, boolean)', 'execute') as anon_rpc,
        has_function_privilege('authenticated', 'public.assistant_channel_thread(text, text, uuid, integer, boolean)', 'execute') as user_rpc,
        has_function_privilege('service_role', 'public.assistant_channel_thread(text, text, uuid, integer, boolean)', 'execute') as service_rpc`);
    assert.deepEqual(reach.rows[0], { anon_table: false, user_table: false, anon_rpc: false, user_rpc: false, service_rpc: true });
    await assert.rejects(db.query("select public.assistant_channel_thread('sms', '1', null, 21600, false)"), /Unsupported channel/);
    await assert.rejects(db.query("select public.assistant_channel_thread('telegram', '1', null, 5, false)"), /at least 60 seconds/);
});

await check("a chat keeps one conversation inside the quiet gap and starts a new one after it", async () => {
    const first = idOf(await turn("hello"));
    const second = await turn("what did I just say?");
    assert.ok(first);
    assert.deepEqual(second, { kind: "message", message: "what did I just say?", conversationId: first });
    const row = await db.query<{ title: string; channel: string; user_profile_id: string }>("select title, channel, user_profile_id from public.conversations where id = $1", [first]);
    assert.deepEqual(row.rows[0], { title: "New Chat", channel: "telegram", user_profile_id: OWNER }, "titled New Chat so the first reply names it");
    await age("1001", 5);
    assert.equal(idOf(await turn("still here")), first, "five quiet hours keep the conversation");
    await age("1001", 7);
    const later = idOf(await turn("good morning"));
    assert.ok(later && later !== first, "seven quiet hours start a new one");
});

await check("/new starts a new conversation, /new with text carries the text, and /help resolves nothing", async () => {
    const current = idOf(await turn("hi"));
    const started = await turn("/new");
    assert.equal(started.kind, "started");
    assert.ok(idOf(started) && idOf(started) !== current);
    const carried = await turn("/new@ZuychinBot plan my week");
    assert.equal(carried.kind, "message");
    assert.equal(carried.kind === "message" && carried.message, "plan my week");
    assert.ok(idOf(carried) !== idOf(started));
    const lookalike = await turn("/newsletter ideas please");
    assert.deepEqual(lookalike, { kind: "message", message: "/newsletter ideas please", conversationId: idOf(carried) });
    seen.length = 0;
    assert.deepEqual(await turn("/help"), { kind: "help" });
    assert.deepEqual(await turn("/help@ZuychinBot"), { kind: "help" });
    assert.equal(seen.length, 0, "/help needs no lookup");
});

await check("two updates arriving together share one conversation", async () => {
    const [a, b] = await Promise.all([turn("first", "3003"), turn("second", "3003")]);
    assert.ok(idOf(a));
    assert.equal(idOf(a), idOf(b));
    const rows = await db.query<{ n: number }>("select count(*)::int as n from public.conversations where channel = 'telegram' and id in (select conversation_id from public.assistant_channel_threads where chat_key = '3003')");
    assert.equal(rows.rows[0].n, 1);
});

await check("another profile or another channel never reuses the chat's conversation", async () => {
    const mine = idOf(await turn("hello", "4004"));
    const theirs = await threads.channelTurn("telegram", "4004", "hello", { profile: async () => ({ id: OTHER }) });
    assert.ok(idOf(theirs) && idOf(theirs) !== mine);
    const discord = idOf(await turn("hello", "4004", "discord"));
    assert.ok(discord && discord !== mine && discord !== idOf(theirs));
    const row = await db.query<{ channel: string }>("select channel from public.conversations where id = $1", [discord]);
    assert.equal(row.rows[0].channel, "discord");
});

await check("without the migration, turns fall back to the shared history", async () => {
    rpcMissing = true;
    assert.deepEqual(await turn("hello"), { kind: "message", message: "hello", conversationId: null });
    assert.deepEqual(await turn("/new"), { kind: "started", conversationId: null });
});

await check("a Telegram nudge is saved into the chat's conversation; a failed send or a Discord route saves nothing", async () => {
    const current = idOf(await turn("checking in"));
    seen.length = 0;
    const sent = await notify("initiative_nudge", "You planned to stretch at 3. Still on?", { noPush: true });
    assert.equal(sent.telegram, true);
    const [saved, ...rest] = savedMessages();
    assert.equal(rest.length, 0);
    assert.equal(saved.role, "assistant");
    assert.equal(saved.channel, "telegram");
    assert.equal(saved.conversation_id, current, "a reply to the nudge lands in the same conversation");
    assert.equal(saved.content, "You planned to stretch at 3. Still on?");
    assert.equal(saved.metadata?.source, "initiative_nudge");

    seen.length = 0;
    telegramStatus = 403;
    assert.equal((await notify("proactive_checkin", "How is the essay going?")).telegram, false);
    assert.equal(savedMessages().length, 0);
    seen.length = 0;
    await notify("daily_briefing", "Morning brief");
    assert.equal(savedMessages().length, 0);
});

await check("the help text and the Telegram menu come from one list", async () => {
    assert.equal(threads.quietGapSeconds({}), 21_600);
    assert.equal(threads.quietGapSeconds({ CHANNEL_QUIET_GAP_MINUTES: "2" }), 120);
    assert.equal(threads.quietGapSeconds({ CHANNEL_QUIET_GAP_MINUTES: "0" }), 21_600);
    assert.match(threads.channelHelpText({}), /after 6 hours without messages/);
    assert.match(threads.channelHelpText({ CHANNEL_QUIET_GAP_MINUTES: "2" }), /after 2 minutes without messages/);
    const help = threads.channelHelpText({});
    for (const c of threads.CHANNEL_COMMANDS) {
        assert.match(c.command, /^[a-z0-9_]{1,32}$/, "Telegram's command name rule");
        assert.ok(c.description.length >= 3 && c.description.length <= 256);
        assert.ok(help.includes(`/${c.command}`));
    }
    assert.deepEqual(threads.CHANNEL_COMMANDS.map((c) => c.command), ["new", "search", "think", "agent", "model", "brief", "translate", "help"]);

    assert.equal(await setTelegramCommands([{ command: "new", description: "Start a new conversation" }]), true);
    const call = seen.find(({ url }) => url.pathname.endsWith("/setMyCommands"));
    assert.deepEqual(JSON.parse(call!.body), { commands: [{ command: "new", description: "Start a new conversation" }] });
    telegramStatus = 400;
    assert.equal(await setTelegramCommands([{ command: "new", description: "Start a new conversation" }]), false);
});

await check("the web lists each conversation's channel, and treats every one as web before the migration", async () => {
    assert.equal((await listConversations(5))[0].channel, "telegram");
    assert.equal((await getConversation("conv-x"))?.channel, "telegram");
    channelColumn = false;
    assert.equal((await listConversations(5))[0].channel, "web");
    assert.equal((await getConversation("conv-x"))?.channel, "web");
    assert.ok(seen.filter(({ url }) => url.pathname === "/rest/v1/conversations").length === 6, "one retry per call without the column");
});

const streamPost = (conversationId: string) => stream.POST(new NextRequest("https://assistant.test/api/chat/stream", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hello", conversationId }),
}));

await check("the chat stream refuses to post into a Telegram or Discord conversation", async () => {
    for (const [channel, name] of [["telegram", "Telegram"], ["discord", "Discord"]]) {
        conversationChannel = channel;
        const res = await streamPost("conv-x");
        assert.equal(res.status, 409);
        assert.match(await res.text(), new RegExp(`This conversation lives in ${name}\\. Reply there to continue\\.`));
    }
    assert.equal(seen.some(({ url }) => url.hostname.includes("googleapis")), false);
    conversationChannel = "web";
    const res = await streamPost("conv-x");
    assert.equal(res.status, 200, "a web conversation goes through to the model");
    await res.body?.cancel();
});

await check("Discord's /new and /help answer without a model turn", async () => {
    const post = (message: string) => chat.POST(new NextRequest("https://assistant.test/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, channel: "discord", chatKey: "ask-zuychin" }),
    }));
    const started = await post("!new");
    assert.equal(started.status, 200);
    assert.equal((await started.json()).reply, threads.CHANNEL_STARTED_TEXT);
    const help = await (await post("/help")).json();
    assert.match(help.reply, /\/new - start a new conversation/);
    assert.equal(seen.some(({ url }) => url.hostname.includes("googleapis")), false);
    const thread = await db.query<{ conversation_id: string }>("select conversation_id from public.assistant_channel_threads where channel = 'discord' and chat_key = 'ask-zuychin'");
    assert.equal(thread.rows.length, 1);
});

await db.close();
console.log(`Channel threads: ${passed} checks passed; the thread RPC ran in PGlite (one connection, so the concurrent check is serialised) and all network transport was mocked.`);
