import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://security-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session-secret", CHAT_API_KEY: "fixture-chat",
    ACCESS_PASSWORD: "correct horse battery", AUTH_ORIGIN: "https://assistant.test",
    TELEGRAM_BOT_TOKEN: "fixture-bot", TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret", TELEGRAM_CHAT_ID: "1001",
    MCP_COUNCIL_HOST_KEY: "fixture-host-key", GEMINI_API_KEY: "fixture-gemini",
});

type Seen = { url: URL; method: string };
const seen: Seen[] = [];
let supabaseReply: (url: URL, method: string) => Response = () => Response.json([]);
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    seen.push({ url, method });
    if (url.hostname === "security-fixture.supabase.co") return supabaseReply(url, method);
    if (url.hostname === "api.telegram.org") return Response.json({ ok: true, result: true });
    throw new Error(`Unexpected offline request to ${url.href}`);
};

const { NextRequest } = await import("next/server");
const { proxy } = await import("../src/proxy");
const webhook = await import("../src/app/api/telegram/webhook/route");
const telegramTest = await import("../src/app/api/telegram/test/route");
const signIn = await import("../src/app/api/auth/route");
const { allowedTelegramChats, updateChatId } = await import("../src/lib/messaging/telegram-access");
const { checkPassword, clientAddress } = await import("../src/lib/auth/attempts");
const { createChallenge } = await import("../src/lib/auth/store");
const { getFile } = await import("../src/lib/vault/github");
const { verifyMcpToken } = await import("../src/lib/agents/mcp-auth");
const { inlineImageSource } = await import("../src/components/markdown-image");

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    seen.length = 0;
    supabaseReply = () => Response.json([]);
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

const telegram = (update: unknown, secret = "fixture-webhook-secret") => new NextRequest("https://assistant.test/api/telegram/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update),
});
const unknownTap = (chatId: number) => ({ callback_query: { id: "cb-1", data: "nothing", message: { message_id: 7, chat: { id: chatId } } } });

await check("the Telegram webhook still refuses a wrong secret before reading the update", async () => {
    assert.equal((await webhook.POST(telegram(unknownTap(1001), "fixture-webhook-secreT"))).status, 401);
    assert.equal(seen.length, 0);
});

await check("a stranger's message, tap or channel post reaches no model, database or Telegram call", async () => {
    for (const update of [
        { message: { message_id: 1, chat: { id: 2002 }, text: "/agent email my notes to someone" } },
        unknownTap(2002),
        { channel_post: { message_id: 2, chat: { id: -100555 }, text: "summarise the vault" } },
        { message: { message_id: 3, text: "no chat at all" } },
    ]) {
        const res = await webhook.POST(telegram(update));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
    }
    assert.equal(seen.length, 0);
});

await check("the owner's chat still gets through", async () => {
    assert.equal((await webhook.POST(telegram(unknownTap(1001)))).status, 200);
    assert.deepEqual(seen.map(({ url }) => url.pathname), ["/botfixture-bot/answerCallbackQuery"]);
});

await check("production ignores every update while no chat is configured", async () => {
    const env = process.env as Record<string, string | undefined>;
    const chat = env.TELEGRAM_CHAT_ID, mode = env.NODE_ENV;
    delete env.TELEGRAM_CHAT_ID;
    env.NODE_ENV = "production";
    try {
        assert.equal((await webhook.POST(telegram(unknownTap(1001)))).status, 200);
        assert.equal(seen.length, 0);
    } finally {
        env.TELEGRAM_CHAT_ID = chat;
        if (mode === undefined) delete env.NODE_ENV; else env.NODE_ENV = mode;
    }
});

await check("chat allowlists accept user and group ids and drop anything else", () => {
    assert.deepEqual([...allowedTelegramChats({ TELEGRAM_CHAT_ID: " 1001 ", TELEGRAM_ALLOWED_CHAT_IDS: "-100200, ,abc,3003" })], ["1001", "-100200", "3003"]);
    assert.equal(allowedTelegramChats({}).size, 0);
    assert.equal(updateChatId({ message: { chat: { id: -5 } } }), "-5");
    assert.equal(updateChatId({ callback_query: { message: { chat: { id: 9 } } }, message: { chat: { id: 1001 } } }), "9");
    assert.equal(updateChatId({ edited_message: { chat: { id: 1001 } } }), null);
});

await check("the Telegram diagnostic needs the owner and writes nothing for anyone else", async () => {
    const res = await telegramTest.GET(new NextRequest("https://assistant.test/api/telegram/test"));
    assert.equal(res.status, 401);
    assert.equal(seen.length, 0);
});

const proxied = (path: string, init: { method?: string; origin?: string; cookie?: boolean } = {}) => proxy(new NextRequest(`https://assistant.test${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.origin ? { origin: init.origin } : {}), ...(init.cookie ? { cookie: "zuychin-auth=stale.value" } : {}) },
}));
const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";
const toLogin = (res: Response) => res.status === 307 && new URL(res.headers.get("location")!, "https://assistant.test").pathname === "/login";

await check("cookie-carrying writes from another origin are refused, including sibling subdomains", async () => {
    for (const origin of ["https://evil.test", "https://next.assistant.test", "null"]) {
        const res = await proxied("/api/chat/stream", { method: "POST", origin, cookie: true });
        assert.equal(res.status, 403);
    }
    assert.ok(passedThrough(await proxied("/api/chat/stream", { method: "POST", origin: "https://assistant.test", cookie: true })));
    assert.ok(passedThrough(await proxied("/api/chat", { method: "POST", origin: "https://evil.test" })), "bearer callers carry no cookie");
    assert.ok(passedThrough(await proxied("/api/chat", { method: "POST", cookie: true })), "non-browser callers send no Origin");
    assert.ok(toLogin(await proxied("/admin", { origin: "https://evil.test", cookie: true })), "reads fall through to the session check");
});

await check("API paths ending in an image extension no longer skip the session check", async () => {
    assert.ok(toLogin(await proxied("/api/artifacts/report.png")));
    assert.ok(toLogin(await proxied("/api/council/CN-ABCD.svg")));
    assert.ok(passedThrough(await proxied("/icons/icon-192.png")));
    assert.ok(passedThrough(await proxied("/favicon.svg")));
});

await check("only the sign-in ceremonies and the Telegram webhook stay public under /api/auth and /api/telegram", async () => {
    assert.ok(passedThrough(await proxied("/api/auth", { method: "POST" })));
    assert.ok(passedThrough(await proxied("/api/auth/passkey", { method: "POST" })));
    assert.ok(passedThrough(await proxied("/api/auth/totp", { method: "POST" })));
    assert.ok(passedThrough(await proxied("/api/telegram/webhook", { method: "POST" })));
    assert.ok(toLogin(await proxied("/api/auth/google/callback")));
    assert.ok(toLogin(await proxied("/api/auth/google/callback?code=x")));
    assert.ok(toLogin(await proxied("/api/telegram/test")));
});

await check("every proxied response carries the security headers, and HSTS only in production", async () => {
    for (const res of [await proxied("/login"), await proxied("/admin"), await proxied("/api/chat", { method: "POST", origin: "https://evil.test", cookie: true })]) {
        assert.equal(res.headers.get("x-frame-options"), "DENY");
        assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
        assert.equal(res.headers.get("strict-transport-security"), null);
    }
    const env = process.env as Record<string, string | undefined>;
    const mode = env.NODE_ENV;
    env.NODE_ENV = "production";
    try { assert.equal((await proxied("/login")).headers.get("strict-transport-security"), "max-age=31536000"); }
    finally { if (mode === undefined) delete env.NODE_ENV; else env.NODE_ENV = mode; }
});

await check("password guesses are limited per client and overall, and a window expiry clears them", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 10; i++) assert.equal(checkPassword("198.51.100.1", "guess", start), "wrong");
    assert.equal(checkPassword("198.51.100.1", "correct horse battery", start), "blocked");
    assert.equal(checkPassword("198.51.100.2", "correct horse battery", start), "ok");
    assert.equal(checkPassword("198.51.100.1", "correct horse battery", start + 15 * 60_000 + 1), "ok");

    const later = start + 60 * 60_000;
    for (let i = 0; i < 200; i++) assert.equal(checkPassword(`203.0.113.${i % 50}:${Math.floor(i / 50)}`, "guess", later), "wrong");
    assert.equal(checkPassword("192.0.2.9", "correct horse battery", later), "blocked");
});

await check("client addresses come from Cloudflare, never from a forged first forwarded hop", () => {
    assert.equal(clientAddress(new Headers({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4" })), "198.51.100.7");
    assert.equal(clientAddress(new Headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.8" })), "198.51.100.8");
    assert.equal(clientAddress(new Headers()), "unknown");
});

const signInRequest = (address: string, password: string) => new NextRequest("https://assistant.test/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": address }, body: JSON.stringify({ password }),
});

await check("password sign-in answers 429 once the limit is reached, before checking the password", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await signIn.POST(signInRequest("198.51.100.20", "guess"))).status, 401);
    const res = await signIn.POST(signInRequest("198.51.100.20", "correct horse battery"));
    assert.equal(res.status, 429);
    assert.equal(res.cookies.get("zuychin-auth"), undefined);
});

await check("password sign-in fails closed when TOTP state or its challenge cannot be stored", async () => {
    supabaseReply = () => Response.json({ message: "upstream unavailable" }, { status: 503 });
    let res = await signIn.POST(signInRequest("198.51.100.30", "correct horse battery"));
    assert.equal(res.status, 503);
    assert.equal(res.cookies.get("zuychin-auth"), undefined);

    supabaseReply = (url, method) => url.pathname === "/rest/v1/auth_totp"
        ? Response.json([{ secret_ciphertext: "x", enabled_at: "2026-01-01T00:00:00Z" }])
        : method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ message: "insert failed" }, { status: 503 });
    res = await signIn.POST(signInRequest("198.51.100.31", "correct horse battery"));
    assert.equal(res.status, 503);
    assert.equal(res.cookies.get("zuychin-auth"), undefined);
});

await check("creating a challenge first removes expired ones", async () => {
    supabaseReply = (_url, method) => method === "DELETE" ? new Response(null, { status: 204 }) : new Response(null, { status: 201 });
    await createChallenge("passkey_auth", "fixture-challenge");
    assert.deepEqual(seen.map(({ method }) => method), ["DELETE", "POST"]);
    assert.match(seen[0].url.searchParams.get("expires_at") ?? "", /^lt\./);
});

await check("vault paths cannot climb out of the vault repository", async () => {
    const cfg = { owner: "fixture", repo: "vault", branch: "main", token: "fixture-token" };
    for (const path of ["../../other-repo/contents/.env", "wiki/../../../../user", "./index.md"]) {
        await assert.rejects(getFile(cfg, path), /'\.' or '\.\.'/);
    }
    assert.equal(seen.length, 0);
});

await check("the Council host key still matches exactly and nothing near it", async () => {
    const req = new Request("https://assistant.test/api/mcp/mcp");
    assert.deepEqual((await verifyMcpToken(req, "fixture-host-key"))?.scopes, ["council:host"]);
    supabaseReply = () => Response.json(null);
    for (const near of ["fixture-host-ke", "fixture-host-keyy", "FIXTURE-HOST-KEY"]) assert.equal(await verifyMcpToken(req, near), undefined);
});

await check("only images this app serves load inline in model answers", () => {
    assert.equal(inlineImageSource("/api/artifacts/a1?x=1"), "/api/artifacts/a1?x=1");
    for (const remote of ["https://collector.test/p.png?d=secret", "//collector.test/p.png", "/\\collector.test/p.png", "vault://note", "", undefined]) {
        assert.equal(inlineImageSource(remote), null, String(remote));
    }
});

console.log(`\n${passed} security boundary checks passed. No live services were exercised.`);
process.exit(0);
