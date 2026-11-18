import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

for (const name of ["GEMINI_API_KEY", "GEMINI_FREE_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "PROVIDER_KEYS_SECRET", "CREDENTIALS_DIRECTORY"]) delete process.env[name];
Object.assign(process.env, { ACCESS_PASSWORD: "fixture-access-password", AUTH_SESSION_SECRET: "fixture-session-secret", CHAT_API_KEY: "fixture-chat-key" });

const { NextRequest } = await import("next/server");
const { KEY_CHECKS, checkProviderKey } = await import("../src/lib/ai/provider-keys/check");
const { decryptApiKey, deriveKey } = await import("../src/lib/ai/provider-keys/crypto");
const { providerKeySnapshot, setProviderKeySnapshotForTests } = await import("../src/lib/ai/provider-keys/snapshot");
const { changesBlockedReason, clearProviderKey, confirmPassword, providerKeysView, saveProviderKey } = await import("../src/lib/ai/provider-keys/admin");
const { PROVIDERS, getProvider, getProviderApiKey } = await import("../src/lib/ai/providers");
const { requireSession } = await import("../src/lib/auth/guard");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
import type { KeyAdminDeps } from "../src/lib/ai/provider-keys/admin";
import type { KeyCheckResult } from "../src/lib/ai/provider-keys/check";
import type { StoredKeyRow } from "../src/lib/ai/provider-keys/store";

let passed = 0;
async function check(name: string, test: () => void | Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

const GROQ_KEY = "gsk_fixture_key_0123456789wxyz";
const master = randomBytes(32);
const derived = deriveKey(master);

function fixture(checkOutcome: KeyCheckResult["outcome"] = "ok") {
    const rows = new Map<string, StoredKeyRow>();
    const sent: string[] = [];
    const calls = { checks: 0, catalogue: 0 };
    const deps: KeyAdminDeps = {
        store: {
            async read() { return { ok: true, rows: [...rows.values()] }; },
            async save(providerId, keyRef, ciphertext) { rows.set(`${providerId}|${keyRef}`, { providerId, keyRef, ciphertext, updatedAt: "" }); return "ok"; },
            async remove(providerId, keyRef) { rows.delete(`${providerId}|${keyRef}`); return "ok"; },
        },
        masters: () => ({ current: { ok: true, key: master, source: "env" }, previous: null }),
        check: async () => {
            calls.checks++;
            const status = checkOutcome === "rejected" ? 401 : checkOutcome === "ok" ? 200 : 503;
            return { outcome: checkOutcome, status, ms: 5, message: checkOutcome === "unknown" ? `Could not confirm the key (HTTP ${status}).` : "fixture" };
        },
        notify: async (text) => { sent.push(text); },
        startCatalogueCheck: async () => { calls.catalogue++; return "started"; },
        now: () => new Date("2026-11-19T01:00:00.000Z"),
    };
    return { rows, sent, calls, deps };
}

function fakeFetch(status: number, body = "{}", seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
        seen.url = String(url);
        seen.init = init;
        return new Response(body, { status });
    }) as typeof fetch;
}

await check("every usable provider declares a key check, and checks send the key only to that provider's own host", async () => {
    for (const provider of PROVIDERS) {
        if (provider.unavailableReason) continue;
        assert.ok(KEY_CHECKS[provider.id], `${provider.id} needs a key check`);
    }
    const groq = getProvider("groq")!;
    const seen: { url?: string; init?: RequestInit } = {};
    assert.equal((await checkProviderKey(groq, GROQ_KEY, fakeFetch(200, "{}", seen))).outcome, "ok");
    assert.equal(seen.url, "https://api.groq.com/openai/v1/models");
    assert.equal((seen.init?.headers as Record<string, string>).Authorization, `Bearer ${GROQ_KEY}`);
    const openrouter = getProvider("openrouter")!;
    await checkProviderKey(openrouter, "or-key-123456", fakeFetch(200, "{}", seen));
    assert.equal(seen.url, "https://openrouter.ai/api/v1/key");
    const nim = getProvider("nvidia-nim")!;
    await checkProviderKey(nim, "nvapi-fixture-123", fakeFetch(200, "{}", seen));
    assert.equal(seen.url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal(JSON.parse(String(seen.init?.body)).max_tokens, 1);
    const gemini = getProvider("gemini")!;
    await checkProviderKey(gemini, "AIza-fixture-123", fakeFetch(200, "{}", seen));
    const geminiUrl = String(seen.url);
    assert.match(geminiUrl, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models/);
    assert.ok(!geminiUrl.includes("AIza"), "the Gemini key goes in a header, not the URL");
});

await check("a key check reads 401, 403 and Gemini's invalid-key 400 as rejected, and other failures as unknown", async () => {
    const groq = getProvider("groq")!, gemini = getProvider("gemini")!;
    assert.equal((await checkProviderKey(groq, GROQ_KEY, fakeFetch(401))).outcome, "rejected");
    assert.equal((await checkProviderKey(groq, GROQ_KEY, fakeFetch(403))).outcome, "rejected");
    assert.equal((await checkProviderKey(gemini, "AIza-bad", fakeFetch(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'))).outcome, "rejected");
    assert.equal((await checkProviderKey(groq, GROQ_KEY, fakeFetch(400, '{"error":{"message":"API key not valid"}}'))).outcome, "unknown", "only Gemini reports a bad key as 400");
    const down = await checkProviderKey(groq, GROQ_KEY, fakeFetch(503));
    assert.equal(down.outcome, "unknown");
    assert.match(down.message, /HTTP 503/);
    const offline = await checkProviderKey(groq, GROQ_KEY, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    assert.deepEqual([offline.outcome, offline.status], ["unknown", null]);
    for (const result of [down, offline]) assert.ok(!JSON.stringify(result).includes(GROQ_KEY));
});

await check("key changes are refused until a master key and the table exist", () => {
    setProviderKeySnapshotForTests({}, { master: "missing" });
    assert.match(changesBlockedReason()!, /No master key is set/);
    setProviderKeySnapshotForTests({}, { master: "invalid" });
    assert.match(changesBlockedReason()!, /openssl rand -base64 32/);
    setProviderKeySnapshotForTests({}, { storage: "migration_required" });
    assert.match(changesBlockedReason()!, /v7-provider-keys\.sql/);
    setProviderKeySnapshotForTests({});
    assert.equal(changesBlockedReason(), null);
    assert.match(changesBlockedReason(providerKeySnapshot(), { ...process.env, ACCESS_PASSWORD: "" })!, /ACCESS_PASSWORD/);
});

await check("a rejected key is not saved and sends no notice", async () => {
    setProviderKeySnapshotForTests({}, { keyRef: derived.ref });
    const { rows, sent, calls, deps } = fixture("rejected");
    const result = await saveProviderKey({ providerId: "groq", apiKey: GROQ_KEY }, deps);
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /rejected this key/);
    assert.equal(rows.size, 0);
    assert.deepEqual([sent.length, calls.catalogue], [0, 0]);
    assert.equal(getProviderApiKey(getProvider("groq")!), undefined);
    for (const bad of ["", "has space inside", 7]) assert.equal((await saveProviderKey({ providerId: "groq", apiKey: bad }, deps)).status, 400);
    assert.equal((await saveProviderKey({ providerId: "nope", apiKey: GROQ_KEY }, deps)).status, 404);
    assert.equal(calls.checks, 1, "malformed input never reaches the provider");
});

await check("a saved key is encrypted at rest, used at once, never echoed, and starts a model check", async () => {
    setProviderKeySnapshotForTests({}, { keyRef: derived.ref });
    const { rows, sent, calls, deps } = fixture("ok");
    const result = await saveProviderKey({ providerId: "groq", apiKey: `  ${GROQ_KEY}\n` }, deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.saved, true);
    assert.equal(result.body.catalogueCheck, "started");
    const stored = rows.get(`groq|${derived.ref}`)!;
    assert.ok(stored && !stored.ciphertext.includes(GROQ_KEY));
    assert.equal(decryptApiKey(derived, "groq", stored.ciphertext), GROQ_KEY);
    assert.equal(getProviderApiKey(getProvider("groq")!), GROQ_KEY, "applies without a reload");
    const text = JSON.stringify(result.body);
    assert.ok(!text.includes(GROQ_KEY) && !text.includes(GROQ_KEY.slice(0, -4)), "the response carries at most the last 4 characters");
    const groqView = (result.body.view as ReturnType<typeof providerKeysView>).providers.find((entry) => entry.id === "groq")!;
    assert.deepEqual([groqView.source, groqView.lastFour, groqView.available], ["dashboard", "wxyz", true]);
    assert.deepEqual(sent, ["Provider key saved for Groq from the dashboard."]);
    assert.ok(!sent.join("").includes("wxyz"));

    const again = await saveProviderKey({ providerId: "groq", apiKey: "gsk_second_key_abcdefghijkl" }, deps);
    assert.equal(again.body.replaced, true);
    assert.equal(sent.at(-1), "Provider key replaced for Groq from the dashboard.");
    assert.equal(calls.catalogue, 2);
    const unchecked = fixture("unknown");
    const warned = await saveProviderKey({ providerId: "kilo", apiKey: "kilo-fixture-key-1234" }, unchecked.deps);
    assert.equal(warned.status, 200);
    assert.match(String(warned.body.warning), /Saved, but could not confirm the key \(HTTP 503\)/);
});

await check("clearing removes only this server's row and falls back to the env var", async () => {
    const other = deriveKey(randomBytes(32));
    setProviderKeySnapshotForTests({ groq: GROQ_KEY }, { keyRef: derived.ref });
    const { rows, sent, deps } = fixture();
    rows.set(`groq|${derived.ref}`, { providerId: "groq", keyRef: derived.ref, ciphertext: "x", updatedAt: "" });
    rows.set(`groq|${other.ref}`, { providerId: "groq", keyRef: other.ref, ciphertext: "y", updatedAt: "" });
    process.env.GROQ_API_KEY = "gsk_env_key_000000000000";
    const result = await clearProviderKey({ providerId: "groq" }, deps);
    assert.equal(result.status, 200);
    assert.deepEqual([...rows.keys()], [`groq|${other.ref}`]);
    assert.equal(getProviderApiKey(getProvider("groq")!), "gsk_env_key_000000000000");
    assert.match(sent[0], /cleared for Groq.*GROQ_API_KEY env var/);
    assert.equal((await clearProviderKey({ providerId: "groq" }, deps)).status, 404, "nothing left to clear");
    const view = providerKeysView().providers.find((entry) => entry.id === "groq")!;
    assert.deepEqual([view.source, view.lastFour], ["environment", "0000"]);
    delete process.env.GROQ_API_KEY;
});

await check("key routes accept only a signed-in browser session, and changes need the access password", async () => {
    const url = "http://127.0.0.1:3000/api/admin/provider-keys";
    assert.equal((await requireSession(new NextRequest(url)))?.status, 401);
    assert.equal((await requireSession(new NextRequest(url, { headers: { authorization: "Bearer fixture-chat-key" } })))?.status, 401, "the bot's bearer key is refused");
    assert.equal(await requireSession(new NextRequest(url, { headers: { cookie: `${AUTH_COOKIE}=${await createSessionValue()}` } })), null);
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.9" });
    assert.equal(confirmPassword(headers, "wrong")?.status, 401);
    assert.equal(confirmPassword(headers, undefined)?.status, 401);
    assert.equal(confirmPassword(headers, "fixture-access-password"), null);
    for (let attempt = 0; attempt < 10; attempt++) confirmPassword(new Headers({ "cf-connecting-ip": "203.0.113.10" }), "wrong");
    assert.equal(confirmPassword(new Headers({ "cf-connecting-ip": "203.0.113.10" }), "fixture-access-password")?.status, 429, "shares sign-in's lockout");
});

console.log(`\n${passed} provider key admin checks passed.`);
