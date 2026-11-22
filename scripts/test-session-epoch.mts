import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://epoch-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session-secret",
    ACCESS_PASSWORD: "correct horse battery", AUTH_ORIGIN: "https://assistant.test",
});

const migration = await readFile(new URL("./migrations/v7-security-hardening.sql", import.meta.url), "utf8");
const setup = await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8");
const db = new PGlite();
await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");

let tableMissing = false;
let readFails = false;
const seen: string[] = [];
const eq = (url: URL, key: string) => url.searchParams.get(key)?.replace(/^eq\./, "") ?? null;
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.hostname !== "epoch-fixture.supabase.co" || url.pathname !== "/rest/v1/auth_session_epoch") throw new Error(`Unexpected offline request to ${url.href}`);
    seen.push(method);
    if (tableMissing) return Response.json({ code: "PGRST205", message: "Could not find the table", details: null, hint: null }, { status: 404 });
    if (readFails && method === "GET") return Response.json({ code: "57014", message: "statement timeout", details: null, hint: null }, { status: 500 });
    if (method === "GET") {
        const { rows } = await db.query("select valid_after from auth_session_epoch where id = $1", [eq(url, "id") === "true"]);
        return Response.json(rows);
    }
    const row = JSON.parse(body);
    await db.query("insert into auth_session_epoch (id, valid_after, updated_at) values ($1, $2, $3) on conflict (id) do update set valid_after = excluded.valid_after, updated_at = excluded.updated_at",
        [row.id, row.valid_after, row.updated_at]);
    return new Response(null, { status: 201 });
};

const { NextRequest } = await import("next/server");
const { createSessionValue, verifySessionValue } = await import("../src/lib/auth/session");
const epoch = await import("../src/lib/auth/session-epoch");
const { proxy } = await import("../src/proxy");
const route = await import("../src/app/api/auth/sessions/route");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    epoch.setSessionEpochSourceForTests();
    tableMissing = false;
    readFails = false;
    seen.length = 0;
    await run();
    passed++;
    console.log(`PASS ${name}`);
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");
/** A cookie in the format issued before this wave: no iat. */
function oldCookie(): string {
    const payload = b64(JSON.stringify({ v: 1, exp: Math.floor(Date.now() / 1000) + 3600, nonce: b64(randomBytes(24)) }));
    return `${payload}.${b64(createHmac("sha256", "fixture-session-secret").update(payload).digest())}`;
}
const now = () => Math.floor(Date.now() / 1000);
const fixed = (value: number | null) => () => Promise.resolve(value);

await check("the migration is embedded in setup verbatim, re-runs cleanly and refuses anon", async () => {
    assert.ok(!migration.includes("\r"), "LF line endings");
    assert.ok(setup.includes(`-- ===== V7 security hardening =====\n-- v7-security-hardening.sql\n${migration.trimEnd()}`));
    await db.exec(migration);
    await db.exec(migration);
    await db.query("insert into auth_session_epoch (valid_after) values (now())");
    await assert.rejects(db.query("insert into auth_session_epoch (id, valid_after) values (false, now())"), /check/i, "only one row can exist");
    await db.exec("set role anon");
    try { await assert.rejects(db.query("select * from auth_session_epoch"), /permission denied/); }
    finally { await db.exec("reset role"); }
    await db.query("delete from auth_session_epoch");
});

await check("with no epoch, old and new cookies are valid", async () => {
    epoch.setSessionEpochSourceForTests(fixed(null));
    assert.equal(await verifySessionValue(oldCookie()), true);
    assert.equal(await verifySessionValue(await createSessionValue()), true);
});

await check("after a sign-out time, earlier cookies are refused and later ones pass", async () => {
    const before = await createSessionValue();
    epoch.setSessionEpochSourceForTests(fixed(now() + 1));
    assert.equal(await verifySessionValue(oldCookie()), false, "a cookie with no issue time counts as issued at 0");
    assert.equal(await verifySessionValue(before), false);
    epoch.setSessionEpochSourceForTests(fixed(now()));
    assert.equal(await verifySessionValue(await createSessionValue()), true, "a cookie issued in the same second still passes");
});

await check("a forged or expired cookie stays refused whatever the epoch", async () => {
    epoch.setSessionEpochSourceForTests(fixed(null));
    const good = await createSessionValue();
    assert.equal(await verifySessionValue(`${good.split(".")[0]}.${b64("forged")}`), false);
    const expired = b64(JSON.stringify({ v: 1, iat: now() - 7200, exp: now() - 10, nonce: "n" }));
    assert.equal(await verifySessionValue(`${expired}.${b64(createHmac("sha256", "fixture-session-secret").update(expired).digest())}`), false);
});

await check("the epoch is read once per 30 seconds, not per request", async () => {
    let reads = 0;
    epoch.setSessionEpochSourceForTests(() => { reads++; return Promise.resolve(null); });
    const cookie = await createSessionValue();
    await Promise.all(Array.from({ length: 20 }, () => verifySessionValue(cookie)));
    assert.equal(reads, 1);
});

await check("a failed read keeps the last known value, and a cold start accepts", async () => {
    let fail = false;
    epoch.setSessionEpochSourceForTests(() => fail ? Promise.reject(new Error("down")) : Promise.resolve(now() + 1));
    const before = await createSessionValue();
    assert.equal(await verifySessionValue(before), false);
    fail = true;
    const holder = globalThis as unknown as Record<symbol, { loadedAt: number }>;
    holder[Symbol.for("zuychin.auth.sessionEpoch")].loadedAt = 0;
    assert.equal(await verifySessionValue(before), false, "the last known epoch still refuses the old cookie");

    epoch.setSessionEpochSourceForTests(() => Promise.reject(new Error("down")));
    assert.equal(await verifySessionValue(before), true, "cold start with the database down accepts a signed cookie");
});

await check("without the table, cookies pass, a warning is logged once, and the panel says it is off", async () => {
    tableMissing = true;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
        assert.equal(await verifySessionValue(oldCookie()), true);
        epoch.setSessionEpochSourceForTests();
        assert.equal(await verifySessionValue(oldCookie()), true);
    } finally { console.warn = warn; }
    assert.equal(warnings.filter((w) => w.includes("auth_session_epoch is missing")).length, 1);
    assert.deepEqual(await epoch.sessionEpochStatus(), { configured: false, validAfter: null });
    await assert.rejects(epoch.signOutEverywhere(), epoch.SessionEpochMissingError);
});

await check("the proxy sends a cancelled cookie to the login page", async () => {
    const cookie = await createSessionValue();
    const visit = () => proxy(new NextRequest("https://assistant.test/admin", { headers: { cookie: `${AUTH_COOKIE}=${cookie}` } }));
    epoch.setSessionEpochSourceForTests(fixed(null));
    assert.equal((await visit()).headers.get("x-middleware-next"), "1");
    epoch.setSessionEpochSourceForTests(fixed(now() + 1));
    const res = await visit();
    assert.equal(res.status, 307);
    assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
});

const post = (body: unknown, headers: Record<string, string>) => route.POST(new NextRequest("https://assistant.test/api/auth/sessions", {
    method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers }, body: JSON.stringify(body),
}));

await check("sign out everywhere needs the session, same origin and the password, then keeps this browser signed in", async () => {
    const other = await createSessionValue();
    const mine = await createSessionValue();
    const cookie = { cookie: `${AUTH_COOKIE}=${mine}` };
    assert.equal((await post({ action: "sign_out_everywhere", password: "correct horse battery" }, {})).status, 401);
    assert.equal((await post({ action: "sign_out_everywhere", password: "correct horse battery" }, { ...cookie, origin: "https://evil.test" })).status, 403);
    assert.equal((await post({ action: "sign_out_everywhere", password: "wrong" }, cookie)).status, 401);
    assert.equal((await post({ action: "something_else", password: "correct horse battery" }, cookie)).status, 400);
    assert.equal((await db.query("select 1 from auth_session_epoch")).rows.length, 0, "nothing was saved by a refused request");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const res = await post({ action: "sign_out_everywhere", password: "correct horse battery" }, cookie);
    assert.equal(res.status, 200);
    const fresh = res.headers.get("set-cookie")?.match(new RegExp(`${AUTH_COOKIE}=([^;]+)`))?.[1];
    assert.ok(fresh, "this browser gets a fresh cookie");
    assert.equal(await verifySessionValue(fresh), true);
    assert.equal(await verifySessionValue(other), false, "the other browser is signed out at once in this process");
    assert.equal((await db.query("select 1 from auth_session_epoch")).rows.length, 1);
    const status = await route.GET(new NextRequest("https://assistant.test/api/auth/sessions", { headers: { cookie: `${AUTH_COOKIE}=${fresh}` } }));
    assert.equal((await status.json()).configured, true);
});

await check("with sign-in off, nothing can be signed out", async () => {
    const saved = { password: process.env.ACCESS_PASSWORD, secret: process.env.AUTH_SESSION_SECRET };
    delete process.env.ACCESS_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;
    try { assert.equal((await post({ action: "sign_out_everywhere", password: "x" }, {})).status, 409); }
    finally { process.env.ACCESS_PASSWORD = saved.password; process.env.AUTH_SESSION_SECRET = saved.secret; }
});

await db.close();
console.log(`Session epoch: ${passed} checks passed; Supabase REST was answered by PGlite.`);
