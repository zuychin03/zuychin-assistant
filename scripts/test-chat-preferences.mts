import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://preferences-fixture.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat",
});
const original = { embeddingModel: "existing-embedding", channelModels: { telegram: "existing-chat" }, voice: { voiceName: "Kore" } };
let preferences: Record<string, unknown> = { ...original };
let failure: "read" | "write" | "missing" | "disappeared" | "conflict" | "conflict-once" | null = null;
let writes = 0;
let reads = 0;
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    assert.equal(url.hostname, "preferences-fixture.supabase.co");
    assert.equal(url.pathname, "/rest/v1/user_profiles");
    const method = init?.method ?? request?.method ?? "GET";
    if (method === "GET") {
        reads++;
        if (failure === "read") return Response.json({ message: "database unavailable" }, { status: 503 });
        return Response.json(failure === "missing" || (failure === "disappeared" && reads > 1) ? null : { id: "profile-1", preferences });
    }
    assert.equal(method, "PATCH");
    assert.equal(url.searchParams.get("id"), "eq.profile-1");
    writes++;
    assert.equal(url.searchParams.get("preferences"), `eq.${JSON.stringify(preferences)}`, "Preference writes must compare the current snapshot");
    if (failure === "write") return Response.json({ message: "write failed" }, { status: 503 });
    if (failure === "conflict") return Response.json(null);
    if (failure === "conflict-once" && writes === 1) {
        preferences = { ...preferences, voice: { ...original.voice, replyWithVoice: "off" } };
        return Response.json(null);
    }
    preferences = JSON.parse(String(init?.body)).preferences;
    return Response.json({ id: "profile-1", preferences });
};
const { GET, PATCH } = await import("../src/app/api/chat/preferences/route");
const { NextRequest } = await import("next/server");
function req(method = "GET", body?: unknown, auth = true) {
    return new NextRequest("https://fixture.invalid/api/chat/preferences", {
        method, headers: { ...(auth ? { authorization: "Bearer fixture-chat" } : {}), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
    failure = null; preferences = { ...original }; writes = 0; reads = 0;
    await run(); passed++; console.log(`PASS ${name}`);
}
await check("GET and PATCH authenticate before database access", async () => {
    assert.equal((await GET(req("GET", undefined, false))).status, 401);
    assert.equal((await PATCH(req("PATCH", { freeOnly: true }, false))).status, 401);
    assert.equal(reads + writes, 0);
});
await check("legacy profile defaults to false with no caching", async () => {
    const response = await GET(req());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(await response.json(), { freeOnly: false });
});
await check("GET reports only strict persisted true", async () => {
    preferences.freeOnly = true;
    assert.deepEqual(await (await GET(req())).json(), { freeOnly: true });
    preferences.freeOnly = "true";
    assert.deepEqual(await (await GET(req())).json(), { freeOnly: false });
});
for (const freeOnly of [true, false]) await check(`PATCH saves ${freeOnly} and preserves existing preferences`, async () => {
    const response = await PATCH(req("PATCH", { freeOnly }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { freeOnly });
    assert.deepEqual(preferences, { ...original, freeOnly });
    assert.equal(writes, 1);
});
for (const body of [null, [], {}, { freeOnly: "true" }, { freeOnly: 1 }, { freeOnly: null }, { freeOnly: true, paidOnly: false }, { freeOnly: true, voice: {} }]) {
    await check(`PATCH rejects invalid fields: ${JSON.stringify(body)}`, async () => {
        assert.equal((await PATCH(req("PATCH", body))).status, 400);
        assert.equal(writes + reads, 0);
    });
}
await check("malformed JSON returns 400", async () => {
    const request = new NextRequest("https://fixture.invalid/api/chat/preferences", { method: "PATCH", headers: { authorization: "Bearer fixture-chat" }, body: "{" });
    assert.equal((await PATCH(request)).status, 400);
    assert.equal(writes + reads, 0);
});
for (const method of ["GET", "PATCH"]) {
    for (const state of ["read", "missing"] as const) await check(`${method} handles ${state} without writing`, async () => {
        failure = state;
        const response = method === "GET" ? await GET(req()) : await PATCH(req("PATCH", { freeOnly: true }));
        assert.equal(response.status, state === "missing" ? 404 : 503);
        assert.equal(writes, 0);
    });
}
for (const state of ["write", "disappeared"] as const) await check(`PATCH does not claim success on ${state}`, async () => {
    failure = state;
    assert.equal((await PATCH(req("PATCH", { freeOnly: true }))).status, state === "write" ? 503 : 404);
    assert.deepEqual(preferences, original);
});
await check("PATCH retries a concurrent voice update without overwriting it", async () => {
    failure = "conflict-once";
    const response = await PATCH(req("PATCH", { freeOnly: true }));
    assert.equal(response.status, 200);
    assert.deepEqual(preferences, { ...original, voice: { ...original.voice, replyWithVoice: "off" }, freeOnly: true });
    assert.equal(writes, 2);
});
await check("PATCH bounds concurrency retries and reports conflict", async () => {
    failure = "conflict";
    assert.equal((await PATCH(req("PATCH", { freeOnly: true }))).status, 409);
    assert.equal(writes, 3);
    assert.deepEqual(preferences, original);
});
console.log(`Chat preferences: ${passed} passed.`);
