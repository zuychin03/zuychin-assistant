import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://policy-race.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-paid",
    NVIDIA_NIM_API_KEY: "fixture-free",
    CHAT_API_KEY: "fixture-chat",
};
const savedEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
Object.assign(process.env, env);

let preferences: Record<string, unknown> = {};
let release: () => void = () => {};
let signalStarted: () => void = () => {};
let blocked: Promise<void>;
let firstWrite = true;
let conflicts = 0;

globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "policy-race.supabase.co", "No external transport is allowed");
    assert.equal(url.pathname, "/rest/v1/user_profiles");
    if ((init?.method ?? "GET") === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { preferences: Record<string, unknown> };
        if (firstWrite) {
            firstWrite = false;
            signalStarted();
            await blocked;
        }
        const expected = url.searchParams.get("preferences");
        assert.ok(expected, "Every preference write must use compare-and-swap");
        assert.ok(expected.startsWith("eq."));
        if (!isDeepStrictEqual(JSON.parse(expected.slice(3)), preferences)) {
            conflicts++;
            return Response.json(null);
        }
        preferences = body.preferences;
        return Response.json({ id: "profile", preferences: structuredClone(preferences) });
    }
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json({
        id: "profile", preferences: structuredClone(preferences),
        display_name: "Fixture", system_prompt: "Fixture",
    });
};

try {
    const { ragChat } = await import("../src/lib/ai/rag-service");
    const { PATCH } = await import("../src/app/api/chat/preferences/route");
    const { NextRequest } = await import("next/server");
    const changeModel = () => ragChat({ channel: "telegram", message: "/model nvidia-nim z-ai/glm-5.3-flash" });
    const enableFreeOnly = () => PATCH(new NextRequest("https://fixture.invalid/api/chat/preferences", {
        method: "PATCH",
        headers: { authorization: "Bearer fixture-chat", "content-type": "application/json" },
        body: JSON.stringify({ freeOnly: true }),
    }));

    for (const botFirst of [true, false]) {
        preferences = { freeOnly: false, voice: { replyWithVoice: "off" } };
        blocked = new Promise((resolve) => { release = resolve; });
        const writeStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
        firstWrite = true;
        conflicts = 0;
        const pending = botFirst ? changeModel() : enableFreeOnly();
        await writeStarted;
        let completed: Awaited<ReturnType<typeof changeModel>> | Response;
        try {
            completed = await (botFirst ? enableFreeOnly() : changeModel());
        } finally {
            release();
        }
        const final = await pending;
        const response = botFirst ? completed : final;
        assert.ok(response instanceof Response);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { freeOnly: true });
        assert.deepEqual(preferences, {
            freeOnly: true,
            voice: { replyWithVoice: "off" },
            channelModels: { telegram: "nvidia-nim::z-ai/glm-5.3-flash" },
        });
        assert.equal(conflicts, 1);
        console.log(`PASS overlapping bot/UI preference writes: ${botFirst ? "bot" : "UI"} writes first`);
    }
    console.log("Chat preference race: 2 production-path checks passed; offline transport only.");
} finally {
    release();
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
