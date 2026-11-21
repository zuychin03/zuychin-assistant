import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { applyV7Base } from "./fixtures/v7-base.mts";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://telegram-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_ORIGIN: "https://assistant.test",
    TELEGRAM_BOT_TOKEN: "fixture-bot", TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret", TELEGRAM_CHAT_ID: "1001",
    GEMINI_API_KEY: "fixture-gemini",
});

type Seen = { url: URL; method: string; body: string };
const seen: Seen[] = [];
let supabaseReply: (url: URL, method: string) => Response = () => Response.json([]);
let telegramReply: (url: URL, body: Record<string, unknown>) => Response = () => Response.json({ ok: true, result: { message_id: 42 } });
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : request ? await request.clone().text() : "";
    seen.push({ url, method, body });
    if (url.hostname === "telegram-fixture.supabase.co") return supabaseReply(url, method);
    if (url.hostname === "api.telegram.org") return telegramReply(url, body ? JSON.parse(body) : {});
    throw new Error(`Unexpected offline request to ${url.href}`);
};

const { NextRequest } = await import("next/server");
const webhook = await import("../src/app/api/telegram/webhook/route");
const { allowedTelegramSenders, telegramSenderAllowed } = await import("../src/lib/messaging/telegram-access");
const { parseTelegramCommand, telegramFailureText } = await import("../src/lib/messaging/telegram-turn");
const { sendTelegramMessage, sendTelegramMessageWithId, telegramChunks } = await import("../src/lib/messaging/telegram-service");

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    seen.length = 0;
    supabaseReply = () => Response.json([]);
    telegramReply = () => Response.json({ ok: true, result: { message_id: 42 } });
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

const post = (update: unknown) => webhook.POST(new NextRequest("https://assistant.test/api/telegram/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "fixture-webhook-secret" }, body: JSON.stringify(update),
}));
const tap = (from: number, extra: Record<string, unknown> = {}) => ({
    ...extra, callback_query: { id: "cb-1", data: "nothing", from: { id: from }, message: { message_id: 7, chat: { id: 1001 } } },
});
const telegramCalls = () => seen.filter(({ url }) => url.hostname === "api.telegram.org").map(({ url }) => url.pathname.split("/").pop());
const dedupeCalls = () => seen.filter(({ url, method }) => url.pathname === "/rest/v1/assistant_channel_updates" && method === "POST");

await check("a message or tap from someone other than the owner, inside the owner's chat, reaches nothing", async () => {
    for (const update of [tap(2002), { message: { message_id: 1, chat: { id: 1001 }, from: { id: 2002 }, text: "/agent email my notes" } }, tap(Number.NaN)]) {
        const res = await post(update);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
    }
    assert.deepEqual(seen, []);
});

await check("the owner's tap is still answered", async () => {
    assert.equal((await post(tap(1001))).status, 200);
    assert.deepEqual(telegramCalls(), ["answerCallbackQuery"]);
});

await check("owner ids come from positive chat ids and TELEGRAM_OWNER_USER_IDS; group ids never count", () => {
    assert.deepEqual([...allowedTelegramSenders({ TELEGRAM_CHAT_ID: "1001", TELEGRAM_ALLOWED_CHAT_IDS: "-100200,3003" })], ["1001", "3003"]);
    assert.deepEqual([...allowedTelegramSenders({ TELEGRAM_CHAT_ID: "-100200", TELEGRAM_OWNER_USER_IDS: " 5005 ,abc,-1" })], ["5005"]);
    assert.equal(allowedTelegramSenders({ TELEGRAM_CHAT_ID: "-100200" }).size, 0);
    const owners = new Set(["1001"]);
    assert.equal(telegramSenderAllowed({ message: { from: { id: 1001 } } }, owners), true);
    assert.equal(telegramSenderAllowed({ message: { chat: { id: 1001 } } }, owners), false, "a message with no sender is refused");
    assert.equal(telegramSenderAllowed({ channel_post: { chat: { id: -100555 } } }, owners), true, "channel posts rely on the chat check");
    assert.equal(telegramSenderAllowed({ edited_message: { from: { id: 1001 } } }, owners), false);
});

await check("a group chat with no owner user id refuses every message and tap", async () => {
    const env = process.env as Record<string, string | undefined>;
    env.TELEGRAM_CHAT_ID = "-100200";
    try {
        const groupTap = { callback_query: { id: "cb-2", data: "nothing", from: { id: 1001 }, message: { message_id: 7, chat: { id: -100200 } } } };
        assert.equal((await post(groupTap)).status, 200);
        assert.deepEqual(seen, []);
    } finally {
        env.TELEGRAM_CHAT_ID = "1001";
    }
});

await check("an update_id runs once: a re-delivery is ignored", async () => {
    supabaseReply = (url, method) => method === "POST" ? Response.json([{ update_key: "77" }]) : Response.json([]);
    await post(tap(1001, { update_id: 77 }));
    assert.equal(dedupeCalls().length, 1);
    assert.match(dedupeCalls()[0].url.search, /on_conflict=channel%2Cupdate_key/);
    assert.deepEqual(JSON.parse(dedupeCalls()[0].body), { channel: "telegram", update_key: "77" });
    assert.deepEqual(telegramCalls(), ["answerCallbackQuery"]);

    seen.length = 0;
    supabaseReply = () => Response.json([]);
    await post(tap(1001, { update_id: 77 }));
    assert.equal(dedupeCalls().length, 1);
    assert.deepEqual(telegramCalls(), [], "the duplicate never reaches Telegram");
});

await check("updates still run when the dedupe table is missing", async () => {
    supabaseReply = () => Response.json({ code: "PGRST205", message: "Could not find the table 'public.assistant_channel_updates'" }, { status: 404 });
    await post(tap(1001, { update_id: 78 }));
    assert.deepEqual(telegramCalls(), ["answerCallbackQuery"]);
});

await check("a failed turn tells the chat in plain words, never the raw error", async () => {
    supabaseReply = (url, method) => url.pathname === "/rest/v1/assistant_channel_updates" && method === "POST"
        ? Response.json([{ update_key: "79" }])
        : Response.json({ message: "secret upstream detail" }, { status: 500 });
    const res = await post({ update_id: 79, message: { message_id: 1, chat: { id: 1001 }, from: { id: 1001 }, text: "hello" } });
    assert.equal(res.status, 200);
    const sends = seen.filter(({ url }) => url.pathname.endsWith("/sendMessage")).map(({ body }) => JSON.parse(body).text as string);
    assert.equal(sends.length, 1);
    assert.match(sends[0], /went wrong|too long|busy|send that again/i);
    assert.doesNotMatch(sends[0], /secret upstream detail/);
});

await check("command prefixes need a word boundary", () => {
    assert.deepEqual(parseTelegramCommand("/thinking about rain"), { search: false, thinking: false, agent: false, text: "/thinking about rain" });
    assert.deepEqual(parseTelegramCommand("/think@zuychin_bot why"), { search: false, thinking: true, agent: false, text: "why" });
    assert.deepEqual(parseTelegramCommand("!search cats\nand dogs"), { search: true, thinking: false, agent: false, text: "cats\nand dogs" });
    assert.deepEqual(parseTelegramCommand("/agent"), { search: false, thinking: false, agent: true, text: "" });
    assert.deepEqual(parseTelegramCommand("/AGENT plan my week"), { search: false, thinking: false, agent: true, text: "plan my week" });
    assert.equal(parseTelegramCommand("/searchable").search, false);
});

await check("failure text names a plain reason and drops provider detail", () => {
    assert.match(telegramFailureText(new Error("Conversation exceeds the 20,000-message context safety limit. Start a new conversation")), /too long/);
    assert.match(telegramFailureText(new Error("Conversation history exceeds the safe context budget.")), /too long/);
    assert.match(telegramFailureText(new Error("Conversation changed while building context. Please retry this message.")), /send that again/);
    assert.match(telegramFailureText(Object.assign(new Error("aborted"), { name: "AbortError" })), /too long and was stopped/);
    assert.match(telegramFailureText(new Error("[429 Too Many Requests] key sk-live-123 over quota")), /busy or out of quota/);
    const generic = telegramFailureText(new Error("ECONNRESET at https://internal.example/path?token=abc"));
    assert.match(generic, /went wrong/);
    assert.doesNotMatch(generic, /token|internal|ECONNRESET/);
});

await check("a rejected MarkdownV2 chunk falls back to that chunk's own text", async () => {
    const paragraphs = ["a", "b", "c"].map((letter) => `${letter.repeat(3000)}.`);
    const text = paragraphs.join("\n");
    telegramReply = (_url, body) => body.parse_mode ? Response.json({ ok: false }, { status: 400 }) : Response.json({ ok: true, result: { message_id: 9 } });
    assert.equal(await sendTelegramMessage("1001", text), true);
    const plain = seen.filter(({ body }) => !JSON.parse(body).parse_mode).map(({ body }) => JSON.parse(body).text as string);
    assert.equal(plain.length, 3);
    assert.deepEqual(plain.map((chunk) => chunk[0]), ["a", "b", "c"], "each fallback sends its own chunk, not the start of the message");
    assert.equal(plain.join("\n"), text);
});

await check("chunks stay within Telegram's limit even when escaping doubles the text", () => {
    const chunks = telegramChunks(".".repeat(9000));
    assert.ok(chunks.length >= 3);
    for (const { plain, formatted } of chunks) {
        assert.ok(formatted.length <= 4096, `formatted chunk is ${formatted.length} characters`);
        assert.ok(plain.length <= 4096);
    }
    assert.equal(chunks.map(({ plain }) => plain).join(""), ".".repeat(9000));
    const short = telegramChunks("short");
    assert.equal(short.length, 1);
    assert.equal(short[0].plain, "short");
    assert.equal(short[0].formatted.trim(), "short");
});

await check("sendTelegramMessageWithId returns the last chunk's message id", async () => {
    let next = 100;
    telegramReply = () => Response.json({ ok: true, result: { message_id: next++ } });
    assert.equal(await sendTelegramMessageWithId("1001", "x".repeat(5000)), 101);
    telegramReply = () => Response.json({ ok: false }, { status: 403 });
    assert.equal(await sendTelegramMessageWithId("1001", "hi", { allowFormattingFallback: false }), null);
});

await check("the V7 channel migration applies twice, is embedded in setup, and stays server-only", async () => {
    const migration = await readFile(new URL("./migrations/v7-channel-threads.sql", import.meta.url), "utf8");
    const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
    assert.ok(setup.includes(`-- ===== V7 channel threads =====\n-- v7-channel-threads.sql\n${migration.trimEnd()}`), "supabase-setup.sql must embed v7-channel-threads.sql verbatim");
    assert.ok(!migration.includes("\r"), "LF line endings");
    const db = new PGlite();
    try {
        await applyV7Base(db);
        await db.exec(migration);
        await db.exec(migration);
        const insert = "insert into public.assistant_channel_updates (channel, update_key) values ('telegram', '77') on conflict do nothing returning update_key";
        assert.equal((await db.query(insert)).rows.length, 1);
        assert.equal((await db.query(insert)).rows.length, 0, "a second claim of the same update gets nothing back");
        await assert.rejects(db.query("insert into public.assistant_channel_updates (channel, update_key) values ('sms', '1')"), /check/);
        const reach = await db.query<{ anon: boolean; authenticated: boolean }>(
            "select has_table_privilege('anon', 'public.assistant_channel_updates', 'select') as anon, has_table_privilege('authenticated', 'public.assistant_channel_updates', 'insert') as authenticated");
        assert.deepEqual(reach.rows[0], { anon: false, authenticated: false });
    } finally {
        await db.close();
    }
});

console.log(`Telegram webhook: ${passed} checks passed; all network transport was mocked.`);
