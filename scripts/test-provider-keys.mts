import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

for (const name of ["GEMINI_API_KEY", "GEMINI_FREE_API_KEY", "OPENROUTER_API_KEY", "PROVIDER_KEYS_SECRET", "PROVIDER_KEYS_SECRET_PREVIOUS", "CREDENTIALS_DIRECTORY"]) delete process.env[name];

const { decodeMasterKey, readMasterKeys } = await import("../src/lib/ai/provider-keys/master");
const { decryptApiKey, deriveKey, encryptApiKey, normaliseApiKey } = await import("../src/lib/ai/provider-keys/crypto");
const { applyProviderKeyChange, loadProviderKeys, providerKeyOrEnv, setProviderKeySnapshotForTests } = await import("../src/lib/ai/provider-keys/snapshot");
const { getProvider, getProviderApiKey, isProviderAvailable, providerKeySource } = await import("../src/lib/ai/providers");
const { ai, geminiClient } = await import("../src/lib/gemini");
const { ocrTiers } = await import("../src/lib/capture/extract/ocr");
import type { KeyStore, StoredKeyRow } from "../src/lib/ai/provider-keys/store";

let passed = 0;
async function check(name: string, test: () => void | Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const masterText = () => randomBytes(32).toString("base64");
const API_KEY = "gsk_fixture_0123456789abcdef";

function memoryStore(initial: StoredKeyRow[] = [], failRead = false) {
    const rows = new Map(initial.map((row) => [`${row.providerId}|${row.keyRef}`, row]));
    const store: KeyStore = {
        async read() { return failRead ? { ok: false, reason: "migration_required" } : { ok: true, rows: [...rows.values()] }; },
        async save(providerId, keyRef, ciphertext) { rows.set(`${providerId}|${keyRef}`, { providerId, keyRef, ciphertext, updatedAt: "2026-11-19T00:00:00.000Z" }); return "ok"; },
        async remove(providerId, keyRef) { rows.delete(`${providerId}|${keyRef}`); return "ok"; },
    };
    return { store, rows };
}
function row(master: Buffer, providerId: string, apiKey: string): StoredKeyRow {
    const key = deriveKey(master);
    return { providerId, keyRef: key.ref, ciphertext: encryptApiKey(key, providerId, apiKey), updatedAt: "2026-11-18T00:00:00.000Z" };
}
const masters = (current: Buffer | null, previous: Buffer | null = null) => ({
    current: current ? { ok: true as const, key: current, source: "env" as const } : { ok: false as const, reason: "missing" as const, source: null },
    previous,
});

await check("a master key is 32 bytes of base64, from the credential file before the env var", () => {
    const text = masterText();
    assert.equal(decodeMasterKey(`${text}\n`)?.length, 32, "openssl output with its newline");
    assert.equal(decodeMasterKey(Buffer.from(text, "base64").toString("base64url"))?.length, 32, "URL-safe form");
    for (const bad of ["", "short", randomBytes(16).toString("base64"), randomBytes(48).toString("base64"), `${text.slice(0, -2)}!=`]) assert.equal(decodeMasterKey(bad), null, bad);

    const files: Record<string, string> = { "/run/creds/provider-keys": text };
    const fromFile = readMasterKeys({ CREDENTIALS_DIRECTORY: "/run/creds", PROVIDER_KEYS_SECRET: masterText() }, (path) => {
        const value = files[path.replace(/\\/g, "/")];
        if (value === undefined) throw new Error("ENOENT");
        return value;
    });
    assert.ok(fromFile.current.ok && fromFile.current.source === "credential");
    assert.deepEqual(fromFile.current.ok && fromFile.current.key, Buffer.from(text, "base64"));
    assert.equal(fromFile.previous, null);

    const fromEnv = readMasterKeys({ PROVIDER_KEYS_SECRET: text, PROVIDER_KEYS_SECRET_PREVIOUS: "not a key" }, () => { throw new Error("no files"); });
    assert.ok(fromEnv.current.ok && fromEnv.current.source === "env");
    assert.equal(fromEnv.previous, null, "an invalid previous key is ignored");
    assert.deepEqual(readMasterKeys({}, () => { throw new Error("no files"); }).current, { ok: false, reason: "missing", source: null });
    assert.deepEqual(readMasterKeys({ PROVIDER_KEYS_SECRET: "too short" }).current, { ok: false, reason: "invalid", source: "env" });
});

await check("a saved key round-trips, and a changed row, another master key or another provider cannot decrypt it", () => {
    const master = randomBytes(32), key = deriveKey(master);
    assert.match(key.ref, /^[0-9a-f]{16}$/);
    assert.equal(deriveKey(Buffer.from(master)).ref, key.ref, "the fingerprint is stable");
    assert.notEqual(deriveKey(randomBytes(32)).ref, key.ref);
    const sealed = encryptApiKey(key, "groq", API_KEY);
    assert.notEqual(encryptApiKey(key, "groq", API_KEY), sealed, "a fresh IV each time");
    assert.ok(!sealed.includes(API_KEY) && !sealed.includes(API_KEY.slice(-4)) && !sealed.includes(Buffer.from(API_KEY).toString("base64url")));
    assert.ok(sealed.length >= 40 && sealed.length <= 4000, "fits the column check");
    assert.equal(decryptApiKey(key, "groq", sealed), API_KEY);

    const parts = sealed.split(".");
    const flipped = parts[3][0] === "A" ? "B" : "A";
    assert.throws(() => decryptApiKey(key, "groq", [...parts.slice(0, 3), flipped + parts[3].slice(1)].join(".")));
    assert.throws(() => decryptApiKey(deriveKey(randomBytes(32)), "groq", sealed));
    assert.throws(() => decryptApiKey(key, "openrouter", sealed), "bound to its provider");
    assert.throws(() => decryptApiKey(key, "groq", `v2${sealed.slice(2)}`), /Unknown stored key format/);
});

await check("pasted keys are trimmed, and spaces inside, control characters or odd lengths are refused", () => {
    assert.equal(normaliseApiKey(`  ${API_KEY}\n`), API_KEY);
    for (const bad of [undefined, 42, "", "short", "has a space inside", "tab\tinside-key", "x".repeat(513), "ключ-ключ-ключ"]) assert.equal(normaliseApiKey(bad), null, String(bad));
});

await check("a load decrypts this server's rows, counts other environments' rows and reports unreadable ones", async () => {
    const mine = randomBytes(32), other = randomBytes(32);
    const tampered = row(mine, "kilo", "kilo-key-123456");
    tampered.ciphertext = encryptApiKey(deriveKey(mine), "groq", "moved-from-groq");
    const { store } = memoryStore([row(mine, "groq", API_KEY), row(other, "groq", "other-env-key"), row(other, "openrouter", "other-env-key-2"), tampered]);
    const loaded = await loadProviderKeys(store, masters(mine));
    assert.equal(loaded.storage, "ok");
    assert.equal(loaded.master, "ready");
    assert.equal(loaded.keyRef, deriveKey(mine).ref);
    assert.deepEqual([...loaded.keys.keys()], ["groq"]);
    assert.equal(loaded.keys.get("groq")?.apiKey, API_KEY);
    assert.equal(loaded.keys.get("groq")?.lastFour, "cdef");
    assert.equal(loaded.otherRows, 2);
    assert.deepEqual(loaded.unreadable, ["kilo"]);

    const noMaster = await loadProviderKeys(store, masters(null));
    assert.equal(noMaster.master, "missing");
    assert.equal(noMaster.keys.size, 0);
    assert.equal(noMaster.otherRows, 4);
});

await check("a failed read keeps the keys already loaded", async () => {
    const mine = randomBytes(32);
    const first = await loadProviderKeys(memoryStore([row(mine, "groq", API_KEY)]).store, masters(mine));
    const failed = await loadProviderKeys(memoryStore([], true).store, masters(mine), first);
    assert.equal(failed.storage, "migration_required");
    assert.equal(failed.keys.get("groq")?.apiKey, API_KEY);
});

await check("with a previous master key, its rows move to the current key once and the old rows go", async () => {
    const oldMaster = randomBytes(32), newMaster = randomBytes(32), other = randomBytes(32);
    const { store, rows } = memoryStore([
        row(oldMaster, "groq", API_KEY), row(oldMaster, "openrouter", "old-openrouter-key"), row(newMaster, "openrouter", "new-openrouter-key"), row(other, "kilo", "dev-kilo-key"),
    ]);
    const loaded = await loadProviderKeys(store, masters(newMaster, oldMaster));
    const newRef = deriveKey(newMaster).ref, oldRef = deriveKey(oldMaster).ref;
    assert.equal(loaded.previousLoaded, true);
    assert.deepEqual(loaded.rotated, ["groq"]);
    assert.equal(loaded.keys.get("groq")?.apiKey, API_KEY);
    assert.equal(loaded.keys.get("openrouter")?.apiKey, "new-openrouter-key", "an existing current row wins over the old one");
    assert.equal(loaded.otherRows, 1);
    assert.deepEqual([...rows.keys()].sort(), [`groq|${newRef}`, `kilo|${deriveKey(other).ref}`, `openrouter|${newRef}`].sort(), "old rows removed, other environments untouched");
    assert.equal(decryptApiKey(deriveKey(newMaster), "groq", rows.get(`groq|${newRef}`)!.ciphertext), API_KEY);
    assert.ok(![...rows.keys()].some((key) => key.endsWith(oldRef)));

    const again = await loadProviderKeys(store, masters(newMaster, oldMaster), loaded);
    assert.deepEqual(again.rotated, ["groq"], "a second load has nothing new to move");
    assert.equal((await loadProviderKeys(store, masters(newMaster, newMaster))).previousLoaded, false, "the same key twice is not a rotation");
});

await check("a dashboard key wins over the env var, clearing it falls back, and it alone makes a provider available", () => {
    const openrouter = getProvider("openrouter")!;
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    setProviderKeySnapshotForTests({ openrouter: "dashboard-openrouter-key" });
    assert.equal(getProviderApiKey(openrouter), "dashboard-openrouter-key");
    assert.equal(providerKeySource(openrouter), "dashboard");
    applyProviderKeyChange("openrouter", null);
    assert.equal(getProviderApiKey(openrouter), "env-openrouter-key");
    assert.equal(providerKeySource(openrouter), "environment");
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(isProviderAvailable(openrouter), false);
    assert.equal(providerKeySource(openrouter), null);
    applyProviderKeyChange("openrouter", { apiKey: "saved-later-key", updatedAt: new Date().toISOString() });
    assert.equal(isProviderAvailable(openrouter), true);
    process.env.OPENROUTER_API_KEY = "";
    assert.equal(providerKeyOrEnv("kilo", "OPENROUTER_API_KEY"), undefined, "an empty env var counts as unset");
});

await check("the shared Gemini client follows the current paid key without a restart, and OCR sees saved keys", () => {
    setProviderKeySnapshotForTests({});
    assert.throws(() => ai.models, /No Gemini API key is set/);
    assert.deepEqual(ocrTiers(false), { free: false, paid: false });
    setProviderKeySnapshotForTests({ gemini: "saved-paid-key-1", "gemini-free": "saved-free-key-1" });
    assert.equal(ai.models, geminiClient("saved-paid-key-1").models);
    assert.equal(geminiClient(), ai);
    assert.notEqual(geminiClient("saved-free-key-1").models, ai.models, "the free key keeps its own client");
    assert.deepEqual(ocrTiers(false), { free: true, paid: true });
    assert.deepEqual(ocrTiers(true), { free: true, paid: false });
    applyProviderKeyChange("gemini", { apiKey: "saved-paid-key-2", updatedAt: new Date().toISOString() });
    assert.equal(ai.models, geminiClient("saved-paid-key-2").models);
    process.env.GEMINI_API_KEY = "env-paid-key";
    applyProviderKeyChange("gemini", null);
    assert.equal(ai.models, geminiClient("env-paid-key").models);
    delete process.env.GEMINI_API_KEY;
});

await check("the migration is embedded in setup, re-runs cleanly, refuses bad rows and stays closed to anon", async () => {
    const migration = await read("./migrations/v7-provider-keys.sql");
    const setup = await read("../supabase-setup.sql");
    const serverOnly = await read("./migrations/server-only-tables.sql");
    assert.ok(!migration.includes("\r"), "LF line endings");
    assert.ok(setup.includes(`-- ===== V7 provider keys =====\n-- v7-provider-keys.sql\n${migration.trimEnd()}`), "supabase-setup.sql must embed v7-provider-keys.sql verbatim");
    assert.ok(serverOnly.includes("('provider_keys')"));

    const db = new PGlite();
    try {
        await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
        await db.exec(migration);
        await db.exec(migration);
        const key = deriveKey(randomBytes(32));
        await db.query("insert into provider_keys (provider_id, key_ref, ciphertext) values ($1, $2, $3)", ["groq", key.ref, encryptApiKey(key, "groq", API_KEY)]);
        await assert.rejects(db.query("insert into provider_keys (provider_id, key_ref, ciphertext) values ($1, $2, $3)", ["groq", key.ref, encryptApiKey(key, "groq", API_KEY)]), /duplicate key/);
        await assert.rejects(db.query("insert into provider_keys (provider_id, key_ref, ciphertext) values ($1, $2, $3)", ["Groq!", key.ref, "x".repeat(60)]), /check constraint/);
        await assert.rejects(db.query("insert into provider_keys (provider_id, key_ref, ciphertext) values ($1, $2, $3)", ["groq", "not-hex", "x".repeat(60)]), /check constraint/);
        await assert.rejects(db.query("insert into provider_keys (provider_id, key_ref, ciphertext) values ($1, $2, $3)", ["kilo", key.ref, "short"]), /check constraint/);
        const rls = (await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'provider_keys'")).rows[0];
        assert.equal(rls.relrowsecurity, true);
        for (const role of ["anon", "authenticated"]) {
            const access = (await db.query<{ open: boolean }>(`select has_table_privilege('${role}', 'public.provider_keys', 'select') or has_table_privilege('${role}', 'public.provider_keys', 'insert') as open`)).rows[0];
            assert.equal(access.open, false, `${role} must not reach provider_keys`);
        }
    } finally {
        await db.close();
    }
});

console.log(`\n${passed} provider key checks passed.`);
