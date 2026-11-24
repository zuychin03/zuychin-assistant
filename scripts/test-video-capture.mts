// Offline checks for V8 F4: the catalogue's video probe step, video model choice, video to notes, the Capture route's
// event stream and Telegram videos with Save to Capture. Every request goes to a fake fetch.
import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://video-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    AUTH_SESSION_SECRET: "fixture-session", CHAT_API_KEY: "fixture-chat", AUTH_ORIGIN: "https://assistant.test",
    NVIDIA_NIM_API_KEY: "fixture-nim", GEMINI_API_KEY: "fixture-gemini", GEMINI_FREE_API_KEY: "fixture-free", KILO_API_KEY: "fixture-kilo",
    TELEGRAM_BOT_TOKEN: "fixture-bot", TELEGRAM_WEBHOOK_SECRET: "fixture-webhook-secret", TELEGRAM_CHAT_ID: "1001",
});

const OWNER = "77777777-7777-4777-8777-777777777777";
const NOTES = "Title: Parcel update\n\n## Summary\nA card says RIVER, then CANDLE.\n\n## Key points\n- The parcel arrives on Friday.\n\n## Transcript\nThe parcel arrives on Friday.";
type Seen = { url: URL; method: string; body: unknown };
const seen: Seen[] = [];
let nimReply: () => Response | "hang" = () => Response.json({ choices: [{ message: { content: NOTES } }] });
const geminiReply: () => Response = () => Response.json({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: NOTES }] } }] });
let telegramFile: Uint8Array<ArrayBuffer> = new Uint8Array(0);
let freeOnlyProfile = false;
const captureRows = new Map<string, Record<string, unknown>>();
const rows = (accept: string | null, list: Record<string, unknown>[]) => accept?.includes("vnd.pgrst.object") ? Response.json(list[0] ?? null) : Response.json(list);
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    const body = init?.body ?? (request ? await request.clone().text() : undefined);
    const accept = new Headers(init?.headers ?? request?.headers).get("accept");
    seen.push({ url, method, body });
    if (url.hostname === "video-fixture.supabase.co") {
        if (url.pathname.endsWith("/user_profiles")) return rows(accept, [{ id: OWNER, display_name: "Owner", system_prompt: null, preferences: { freeOnly: freeOnlyProfile } }]);
        if (url.pathname.endsWith("/model_call_observations")) return new Response(null, { status: 201 });
        if (url.pathname.endsWith("/assistant_channel_updates") && method === "POST") return Response.json([{ update_key: "claimed" }]);
        if (url.pathname.endsWith("/capture_inbox")) {
            if (method === "POST") {
                const row = JSON.parse(String(body)) as Record<string, unknown>;
                if (!captureRows.has(String(row.id))) captureRows.set(String(row.id), { ...row, created_at: "2026-11-25T00:00:00.000Z", receipt: null });
                return new Response(null, { status: 201 });
            }
            const id = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
            return rows(accept, captureRows.has(id) ? [captureRows.get(id)!] : []);
        }
        return Response.json([]);
    }
    if (url.hostname === "integrate.api.nvidia.com") {
        const reply = nimReply();
        if (reply !== "hang") return reply;
        const keepAlive = setTimeout(() => undefined, 60_000);
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); reject(init.signal!.reason); }));
    }
    if (url.hostname === "generativelanguage.googleapis.com") return geminiReply();
    if (url.href === "https://api.telegram.org/botfixture-bot/getFile") return Response.json({ ok: true, result: { file_path: "videos/clip.mp4" } });
    if (url.href === "https://api.telegram.org/file/botfixture-bot/videos/clip.mp4") return new Response(telegramFile);
    if (url.hostname === "api.telegram.org") return Response.json({ ok: true, result: { message_id: 9 } });
    throw new Error(`Unexpected offline request to ${url.href}`);
};
const logs: string[] = [];
const log = console.log;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

const { NextRequest } = await import("next/server");
const { bodyLimit, NEXT_BODY_LIMIT, VIDEO_BODY_LIMIT } = await import("../src/lib/http/limits");
const { PROBE_CLIP_MP4_BASE64 } = await import("../src/lib/ai/catalogue/probe-clip");
const { probeModel, heardClipSpeech } = await import("../src/lib/ai/catalogue/probe");
const { applyProbe, chatProbeChecks } = await import("../src/lib/ai/catalogue/run");
const { traitsFromDb } = await import("../src/lib/ai/catalogue/rows");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { getProvider } = await import("../src/lib/ai/providers");
const { collectModelObservations, configureModelDataPolicy } = await import("../src/lib/ai/model-observations");
const video = await import("../src/lib/capture/video");
const { postVideo, readVideoEvents, VIDEO_UPLOAD_MAX_BYTES } = await import("../src/lib/capture/video-client");
const { acquireSlot } = await import("../src/lib/capture/extract/gate");
const { telegramVideo, videoNotesHeading } = await import("../src/lib/messaging/telegram-video");
const { transcriptCaptureId } = await import("../src/lib/messaging/telegram-recording");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
const { CAPTURE_TEXT_MAX } = await import("../src/lib/voice/recording-limits");
const videoRoute = await import("../src/app/api/capture/video/route");
const webhook = await import("../src/app/api/telegram/webhook/route");
type CatalogueRow = import("../src/lib/ai/catalogue/snapshot").CatalogueRow;
type ProbeResult = import("../src/lib/ai/catalogue/probe").ProbeResult;
type VideoModel = import("../src/lib/capture/video").VideoModel;

let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
    seen.length = 0;
    logs.length = 0;
    await run();
    passed++;
    log(`PASS ${name}`);
}

const clip = new Uint8Array(Buffer.from(PROBE_CLIP_MP4_BASE64, "base64"));
/** An ISO media header followed by filler: enough for the byte check, never decoded. */
const fakeMp4 = (bytes: number) => { const out = new Uint8Array(bytes); out.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); return out; };
const AT = "2026-11-24T00:00:00.000Z";
function chatRow(overrides: Partial<CatalogueRow> & Pick<CatalogueRow, "providerId" | "modelId">): CatalogueRow {
    return {
        origin: "discovered", label: overrides.modelId, shortName: overrides.modelId.replace(/^.*\//, "").replace(/:.*$/, ""), description: null, developer: null,
        free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: [],
        listedTools: null, listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: AT, probeChatMs: 2000,
        supportsTools: true, supportsSearch: true, supportsVision: true, supportsThinking: null, supportsStructured: null,
        firstSeenAt: AT, lastSeenAt: AT, missedChecks: 0, missingSince: null, notifiedMissingAt: null,
        approvedAt: AT, kind: "chat", traits: { video: true, videoSpeech: true },
        ...overrides,
    };
}
const VIDEO_ROWS = [
    chatRow({ providerId: "nvidia-nim", modelId: "nvidia/vl-reader", label: "VL Reader", probeChatMs: 900, traits: { video: true, videoSpeech: false } }),
    chatRow({ providerId: "nvidia-nim", modelId: "nvidia/omni-reader", label: "Omni Reader", probeChatMs: 3000 }),
    chatRow({ providerId: "gemini", modelId: "gemini-paid-video", label: "Paid Video", free: false }),
    chatRow({ providerId: "nvidia-nim", modelId: "nvidia/unapproved", label: "Unapproved", approvedAt: null }),
    chatRow({ providerId: "nvidia-nim", modelId: "nvidia/stills-only", label: "Stills Only", traits: { video: false } }),
    chatRow({ providerId: "nvidia-nim", modelId: "nvidia/untested", label: "Untested", traits: {} }),
    chatRow({ providerId: "nvidia-nim", modelId: "nvidia/failing", label: "Failing", probeStatus: "failed" }),
];
setCatalogueSnapshotForTests(VIDEO_ROWS);
const labels = (models: readonly VideoModel[]) => models.map((model) => model.label);
const model = (providerId: string, modelId: string, label: string, speech = true, free = true): VideoModel =>
    ({ provider: getProvider(providerId)!, modelId, apiKey: `key-${providerId}`, label, free, speech });

function sse(frames: unknown[], status = 200): Response {
    return new Response(frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join(""), { status, headers: { "Content-Type": "text/event-stream" } });
}
const streamed = (content: string) => sse([{ choices: [{ delta: { content } }] }, "[DONE]"]);
type Step = "chat" | "tools" | "vision" | "video";
function probeStub(replies: Partial<Record<Step, () => Response | "hang">>, sent: { step: Step; body: Record<string, unknown> }[]): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const messages = body.messages as { content: unknown }[] | undefined;
        const parts = (body.contents as { parts: Record<string, unknown>[] }[] | undefined)?.[0].parts;
        const media = JSON.stringify(messages?.[0].content ?? parts ?? "");
        const step: Step = body.tools ? "tools" : media.includes("video") ? "video" : media.includes("image") ? "vision" : "chat";
        sent.push({ step, body });
        const reply = replies[step]?.() ?? Response.json({ error: { message: `no stub for ${step}` } }, { status: 500 });
        if (reply !== "hang") return reply;
        // AbortSignal.timeout alone does not keep the process alive.
        const keepAlive = setTimeout(() => undefined, 60_000);
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); reject(init.signal!.reason); }));
    }) as typeof fetch;
}
const answers = { chat: () => streamed("OK"), tools: () => streamed("I would echo it."), vision: () => streamed("Red.") };

await check("the probe clip is a small synthetic MP4 and the size limits agree", () => {
    assert.ok(clip.byteLength < 300 * 1024, `${clip.byteLength} bytes`);
    assert.equal(video.videoMime(clip), "video/mp4");
    assert.equal(video.videoMime(new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20])), "video/quicktime");
    assert.equal(video.videoMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])), "video/webm");
    assert.equal(video.videoMime(new TextEncoder().encode("%PDF-1.7 not a video")), null);
    assert.equal(VIDEO_BODY_LIMIT, 7 * 1024 * 1024);
    assert.equal(bodyLimit("/api/capture/video"), VIDEO_BODY_LIMIT);
    assert.equal(video.VIDEO_WEB_MAX_BYTES, VIDEO_BODY_LIMIT);
    assert.equal(VIDEO_UPLOAD_MAX_BYTES, VIDEO_BODY_LIMIT, "the page and the route refuse the same size");
    assert.ok(VIDEO_BODY_LIMIT < NEXT_BODY_LIMIT);
    assert.equal(video.VIDEO_TELEGRAM_MAX_BYTES, 20 * 1024 * 1024);
});

await check("the probe sends the clip after the image step and records whether the model read and heard it", async () => {
    const sent: { step: Step; body: Record<string, unknown> }[] = [];
    const heard = await probeModel({ provider: getProvider("nvidia-nim")!, modelId: "nvidia/omni", apiKey: "k", checkVision: true, checkVideo: "after-vision" },
        { fetchImpl: probeStub({ ...answers, video: () => streamed("Words: RIVER, CANDLE\nVoice: The parcel arrives on Friday.") }, sent) });
    assert.deepEqual(sent.map(({ step }) => step), ["chat", "tools", "vision", "video"]);
    const content = (sent[3].body.messages as { content: { type: string; video_url?: { url: string } }[] }[])[0].content;
    assert.equal(content[1].type, "video_url");
    assert.equal(content[1].video_url!.url, `data:video/mp4;base64,${PROBE_CLIP_MP4_BASE64}`);
    assert.equal(heard.status, "passed");
    assert.equal(heard.supportsVideo, true);
    assert.equal(heard.videoSpeech, true);
    assert.equal(heard.steps.video.outcome, "pass");

    const gemini = (text: string) => () => sse([{ candidates: [{ content: { parts: [{ text }] } }] }]);
    const deaf = await probeModel({ provider: getProvider("gemini-free")!, modelId: "gemini-x", apiKey: "k", checkVision: true, checkVideo: true },
        { fetchImpl: probeStub({ chat: gemini("OK"), tools: gemini("I would echo it."), vision: gemini("Red."), video: gemini("Words: river candle\nVoice: none") }, sent) });
    assert.equal(deaf.supportsVideo, true);
    assert.equal(deaf.videoSpeech, false);
    const parts = (sent.at(-1)!.body.contents as { parts: { inlineData?: { mimeType: string } }[] }[])[0].parts;
    assert.equal(parts[1].inlineData?.mimeType, "video/mp4");
    assert.equal(heardClipSpeech("The parcel arrives on Friday."), true);
    assert.equal(heardClipSpeech("Voice: none"), false);
});

await check("a refused clip marks no video; a slow one leaves it unknown and never fails the chat probe", async () => {
    const sent: { step: Step; body: Record<string, unknown> }[] = [];
    const target = { provider: getProvider("kilo")!, modelId: "acme/vl:free", apiKey: "k", checkVision: true, checkVideo: true } as const;
    const refused = await probeModel(target, { fetchImpl: probeStub({ ...answers, video: () => Response.json({ error: { message: "This request requires at least $1.00 in balance for video." } }, { status: 402 }) }, sent) });
    assert.equal(refused.status, "passed");
    assert.equal(refused.supportsVideo, false);
    assert.equal(refused.videoSpeech, false);
    assert.match(refused.steps.video.detail ?? "", /balance for video/);

    const wrong = await probeModel(target, { fetchImpl: probeStub({ ...answers, video: () => streamed("Words: RIVER\nVoice: none") }, sent) });
    assert.equal(wrong.supportsVideo, false, "both cards must be read, not just the first frame");

    const slow = await probeModel(target, { fetchImpl: probeStub({ ...answers, video: () => "hang" }, sent), timeouts: { video: 50 } });
    assert.equal(slow.status, "passed");
    assert.equal(slow.supportsVideo, null);
    assert.equal(slow.videoSpeech, null);
    assert.equal(slow.steps.video.outcome, "transient");

    sent.length = 0;
    await probeModel({ ...target, checkVideo: "after-vision" }, { fetchImpl: probeStub({ ...answers, vision: () => streamed("Blue.") }, sent) });
    assert.ok(!sent.some(({ step }) => step === "video"), "no clip after a failed image step");
});

await check("listed inputs decide the image and video steps whatever their case", () => {
    assert.deepEqual(chatProbeChecks({ inputs: [] }), { checkVision: true, checkVideo: "after-vision" });
    assert.deepEqual(chatProbeChecks({ inputs: ["Text", "Image", "Video"] }), { checkVision: true, checkVideo: true });
    assert.deepEqual(chatProbeChecks({ inputs: ["Text", "Image"] }), { checkVision: true, checkVideo: false }, "listings say \"Image\", not \"image\"");
    assert.deepEqual(chatProbeChecks({ inputs: ["text"] }), { checkVision: false, checkVideo: false });
});

await check("a passed probe stores the video traits; a probe that did not try the clip keeps the old ones", () => {
    const row = chatRow({ providerId: "kilo", modelId: "acme/vl:free", traits: { familyId: "acme-vl", video: true, videoSpeech: true } });
    const result = (extra: Partial<ProbeResult>): ProbeResult => ({
        status: "passed", retired: false, chatMs: 900, supportsTools: true, supportsSearch: true, supportsVision: true, supportsVideo: null, videoSpeech: null,
        steps: {} as ProbeResult["steps"], ...extra,
    });
    assert.deepEqual(applyProbe(row, result({ supportsVideo: true, videoSpeech: false }), AT).traits, { familyId: "acme-vl", video: true, videoSpeech: false });
    assert.deepEqual(applyProbe(row, result({ supportsVideo: false, videoSpeech: false }), AT).traits, { familyId: "acme-vl", video: false, videoSpeech: false });
    assert.deepEqual(applyProbe(row, result({}), AT).traits, row.traits);
    assert.deepEqual(traitsFromDb({ video: true, videoSpeech: false, junk: 1 }), { video: true, videoSpeech: false });
});

await check("video models: approved rows that passed the clip, free first, speech before none, and Free only drops paid", () => {
    assert.deepEqual(labels(video.videoModels(false)), ["Omni Reader", "VL Reader", "Paid Video"]);
    assert.deepEqual(labels(video.videoModels(true)), ["Omni Reader", "VL Reader"]);
    assert.deepEqual(video.videoModels(false).map((entry) => entry.speech), [true, false, true]);
});

await check("notes come back as a title and Markdown, with thinking, fences and bold labels removed", () => {
    assert.deepEqual(video.parseVideoNotes(NOTES, "Fallback"), { title: "Parcel update", text: NOTES.slice(NOTES.indexOf("## Summary")) });
    assert.deepEqual(video.parseVideoNotes("<think>plan</think>\n```markdown\n**Title:** *Site walk*\n\n## Summary\nDone.\n```", "Fallback"), { title: "Site walk", text: "## Summary\nDone." });
    assert.deepEqual(video.parseVideoNotes("## Summary\nNo title line.", "Video 25/11/2026"), { title: "Video 25/11/2026", text: "## Summary\nNo title line." });
    assert.equal(video.parseVideoNotes("Title: Only a title", "Fallback"), null);
    assert.equal(video.parseVideoNotes(`Title: Long\n\n${"x".repeat(CAPTURE_TEXT_MAX + 50)}`, "F")!.text.length, CAPTURE_TEXT_MAX);
    assert.ok(video.videoNotesPrompt(true).includes("## Transcript") && !video.videoNotesPrompt(false).includes("## Transcript"));
    assert.equal(video.videoTitle({ fileName: "site_walk-03.mp4" }), "site walk 03");
    assert.equal(video.videoTitle({ fileName: "video.mp4", sentAt: 1764000000 }), "Video 25/11/2025");
});

await check("video to notes: the best model first, the next one after a failure, and a note when the model cannot hear", async () => {
    nimReply = () => Response.json({ error: { message: "overloaded" } }, { status: 503 });
    try {
        const result = await video.videoToNotes({ bytes: clip, title: "Fallback" }, { freeOnly: false, models: [model("nvidia-nim", "nvidia/omni", "Omni"), model("gemini", "gemini-paid-video", "Paid", true, false)] });
        assert.deepEqual(result, { ok: true, title: "Parcel update", text: NOTES.slice(NOTES.indexOf("## Summary")), model: "Paid", speech: true });
    } finally { nimReply = () => Response.json({ choices: [{ message: { content: NOTES } }] }); }
    const nim = JSON.parse(String(seen.find(({ url }) => url.hostname === "integrate.api.nvidia.com")!.body)) as {
        model: string; stream: boolean; max_tokens: number; chat_template_kwargs?: unknown; messages: { content: { type: string; text?: string; video_url?: { url: string } }[] }[];
    };
    assert.equal(nim.model, "nvidia/omni");
    assert.equal(nim.stream, false);
    assert.deepEqual(nim.chat_template_kwargs, { enable_thinking: false }, "thinking used up the reply on a 90 s video live");
    assert.equal(nim.max_tokens, 8192);
    assert.equal(nim.messages[0].content[1].video_url!.url, `data:video/mp4;base64,${PROBE_CLIP_MP4_BASE64}`);
    const gemini = seen.find(({ url }) => url.hostname === "generativelanguage.googleapis.com")!;
    assert.match(gemini.url.pathname, /\/models\/gemini-paid-video:generateContent$/);
    assert.equal((JSON.parse(String(gemini.body)) as { contents: { parts: { inlineData?: { mimeType: string } }[] }[] }).contents[0].parts[1].inlineData?.mimeType, "video/mp4");

    seen.length = 0;
    const deaf = await video.videoToNotes({ bytes: clip, title: "Fallback" }, { freeOnly: false, models: [model("nvidia-nim", "nvidia/vl", "VL", false)] });
    assert.ok(deaf.ok && deaf.text.endsWith("_No transcript: the model that read this video cannot hear its speech._") && !deaf.speech);
    const prompt = (JSON.parse(String(seen[0].body)) as { messages: { content: { text?: string }[] }[] }).messages[0].content[0].text!;
    assert.ok(!prompt.includes("## Transcript"), "no transcript is asked of a model that cannot hear");
});

await check("video to notes turns down what it cannot send: not a video, no model, too large for every model", async () => {
    assert.deepEqual(await video.videoToNotes({ bytes: new TextEncoder().encode("not a video at all"), title: "F" }, { freeOnly: false, models: [model("nvidia-nim", "a", "A")] }), { ok: false, reason: "unsupported" });
    assert.deepEqual(await video.videoToNotes({ bytes: clip, title: "F" }, { freeOnly: false, models: [] }), { ok: false, reason: "no_model" });
    assert.deepEqual(await video.videoToNotes({ bytes: fakeMp4(15 * 1024 * 1024), title: "F" }, { freeOnly: false, models: [model("gemini-free", "gemini-x", "G")] }), { ok: false, reason: "too_large" },
        "Gemini takes inline video up to 14 MB");
    assert.equal(seen.length, 0, "nothing was sent");

    nimReply = () => Response.json({ error: { message: "rate limited" } }, { status: 429 });
    try {
        const busy = await video.videoToNotes({ bytes: clip, title: "F" }, { freeOnly: false, models: [model("nvidia-nim", "a", "A"), model("nvidia-nim", "b", "B"), model("nvidia-nim", "c", "C")] });
        assert.deepEqual(busy, { ok: false, reason: "busy", detail: "B: rate limited" });
        assert.equal(seen.filter(({ url }) => url.hostname === "integrate.api.nvidia.com").length, 2, "two models at most");
    } finally { nimReply = () => Response.json({ choices: [{ message: { content: NOTES } }] }); }

    nimReply = () => "hang";
    try {
        const slow = await video.videoToNotes({ bytes: clip, title: "F" }, { freeOnly: false, models: [model("nvidia-nim", "a", "A")], totalMs: 1200 });
        assert.equal(slow.ok, false);
        assert.equal(!slow.ok && slow.reason, "timeout");
    } finally { nimReply = () => Response.json({ choices: [{ message: { content: NOTES } }] }); }
});

await check("Free only refuses a paid video model before anything is sent and uses the free one", async () => {
    const { value } = await collectModelObservations(async () => {
        configureModelDataPolicy(true);
        return video.videoToNotes({ bytes: clip, title: "F" }, { freeOnly: true, models: [model("gemini", "gemini-paid-video", "Paid", true, false), model("nvidia-nim", "nvidia/omni-reader", "Omni Reader")] });
    }, ["personal"]);
    assert.ok(value.ok && value.model === "Omni Reader");
    assert.equal(seen.filter(({ url }) => url.hostname === "generativelanguage.googleapis.com").length, 0);
});

const cookie = `${AUTH_COOKIE}=${await createSessionValue()}`;
const post = (body: Uint8Array, headers: Record<string, string> = { cookie, "content-type": "video/mp4" }) =>
    videoRoute.POST(new NextRequest("https://assistant.test/api/capture/video", { method: "POST", headers, body: body as BodyInit }));
const viaRoute: typeof fetch = async (input, init) => videoRoute.POST(new NextRequest(`https://assistant.test${String(input)}`,
    { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } } as ConstructorParameters<typeof NextRequest>[1]));

await check("Capture route: session, same origin, video bytes up to 7 MB, a model, and one video at a time", async () => {
    assert.equal((await post(clip, { "content-type": "video/mp4" })).status, 401);
    assert.equal((await post(clip, { cookie, origin: "https://evil.test", "content-type": "video/mp4" })).status, 403);
    assert.equal((await post(clip, { cookie, "content-type": "text/plain" })).status, 415);
    const big = await post(fakeMp4(VIDEO_BODY_LIMIT + 1));
    assert.equal(big.status, 413);
    assert.match(String(((await big.json()) as { error: string }).error), /up to 7 MB.*Telegram bot/);
    assert.equal((await post(new TextEncoder().encode("plain text pretending"))).status, 415);

    const release = acquireSlot("video")!;
    try { assert.equal((await post(clip)).status, 429); } finally { release(); }

    setCatalogueSnapshotForTests(VIDEO_ROWS.filter((row) => row.traits?.video !== true));
    try {
        const none = await post(clip);
        assert.equal(none.status, 503);
        assert.match(String(((await none.json()) as { error: string }).error), /^Video summaries are unavailable right now/);
    } finally { setCatalogueSnapshotForTests(VIDEO_ROWS); }
    assert.equal(seen.filter(({ url }) => url.hostname === "integrate.api.nvidia.com").length, 0, "turned-down videos reach no model");
});

await check("Capture route streams the notes as events, logs sizes without words, keeps nothing and frees the slot", async () => {
    const started: string[] = [];
    const notes = await postVideo(new File([clip], "parcel.mp4", { type: "video/mp4" }), { fetchImpl: viaRoute, onStarted: (name) => started.push(name) });
    assert.deepEqual(started, ["Omni Reader"]);
    assert.deepEqual(notes, { type: "done", title: "Parcel update", text: NOTES.slice(NOTES.indexOf("## Summary")), model: "Omni Reader", speech: true });
    assert.ok(logs.some((line) => line.includes("\"capture_video\"") && line.includes("\"ok\":true")));
    assert.ok(!logs.some((line) => line.includes("parcel arrives")), "the log keeps no words");
    assert.equal(seen.filter(({ url }) => url.pathname.endsWith("/capture_inbox")).length, 0, "the route stores no capture");
    assert.ok(seen.some(({ url }) => url.pathname.endsWith("/model_call_observations")), "the call is recorded as a model observation");
    const again = acquireSlot("video");
    assert.ok(again, "the slot is free again");
    again!();

    freeOnlyProfile = true;
    nimReply = () => Response.json({ error: { message: "bad video" } }, { status: 400 });
    try {
        await assert.rejects(postVideo(new File([clip], "parcel.mp4", { type: "video/mp4" }), { fetchImpl: viaRoute }), /^Error: The video could not be summarised/);
        assert.equal(seen.filter(({ url }) => url.hostname === "generativelanguage.googleapis.com").length, 0, "Free only never tries the paid model");
    } finally { freeOnlyProfile = false; nimReply = () => Response.json({ choices: [{ message: { content: NOTES } }] }); }

    await assert.rejects(postVideo(new File([fakeMp4(VIDEO_BODY_LIMIT + 1)], "big.mp4", { type: "video/mp4" }), { fetchImpl: viaRoute }), /up to 7 MB/);
});

await check("the page's reader skips heartbeats and fails clearly when the stream ends early", async () => {
    const stream = (text: string) => new Response(text).body!;
    const done = await readVideoEvents(stream(": wait\n\ndata: {\"type\":\"started\",\"model\":\"M\"}\n\n: wait\n\ndata: {\"type\":\"done\",\"title\":\"T\",\"text\":\"B\",\"model\":\"M\",\"speech\":false}\n\n"));
    assert.deepEqual(done, { type: "done", title: "T", text: "B", model: "M", speech: false });
    await assert.rejects(readVideoEvents(stream(": wait\n\n")), /closed before the notes arrived/);
    await assert.rejects(readVideoEvents(stream("data: {\"type\":\"error\",\"error\":\"Too slow.\"}\n\n")), /^Error: Too slow\.$/);
});

await check("Telegram: a video, round video or video file with no caption is a clip; a caption keeps it a chat question", () => {
    const base = { file_id: "v1", file_size: clip.byteLength, duration: 12 };
    assert.deepEqual(telegramVideo({ video: base, date: 1764000000 }), { fileId: "v1", fileSize: clip.byteLength, seconds: 12, title: "Video 25/11/2025" });
    assert.equal(telegramVideo({ video: base, caption: "what is happening here?" }), null);
    assert.equal(telegramVideo({ videoNote: { file_id: "n1", duration: 9 } })?.seconds, 9);
    assert.equal(telegramVideo({ document: { file_id: "d1", mime_type: "video/quicktime", file_name: "Site walk.mov" } })?.title, "Site walk");
    assert.equal(telegramVideo({ document: { file_id: "d2", mime_type: "application/pdf" } }), null);
    assert.equal(videoNotesHeading("Parcel update", 12), "Video notes: Parcel update (12 s)");
    assert.equal(videoNotesHeading("Parcel update", 0), "Video notes: Parcel update");
});

const telegramUpdate = (updateId: number, message: Record<string, unknown>) => new NextRequest("https://assistant.test/api/telegram/webhook", {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "fixture-webhook-secret" },
    body: JSON.stringify({ update_id: updateId, ...message }),
});
const videoMessage = (updateId: number, extra: Record<string, unknown> = {}) => telegramUpdate(updateId,
    { message: { message_id: 5, date: 1764000000, chat: { id: 1001 }, from: { id: 1001 }, video: { file_id: "video-1", duration: 12, file_size: clip.byteLength }, ...extra } });
const telegramSends = (method: string) => seen.filter(({ url }) => url.hostname === "api.telegram.org" && url.pathname.endsWith(`/${method}`));
type Sent = { text: string; parse_mode?: string; reply_markup?: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } };
const sentText = (entry: Seen): Sent => {
    const sent = JSON.parse(String(entry.body)) as Sent;
    return sent.parse_mode === "MarkdownV2" ? { ...sent, text: sent.text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1").trim() } : sent;
};
const chatTurns = () => seen.filter(({ url, method }) => url.pathname === "/rest/v1/messages" && method === "POST");

await check("Telegram webhook: a video gets Summarising, then the notes with Save to Capture, and no chat turn", async () => {
    telegramFile = clip;
    await webhook.POST(videoMessage(501));
    const sends = telegramSends("sendMessage").map(sentText);
    assert.equal(sends.length, 2);
    assert.equal(sends[0].text, "Summarising the video. I will send the notes when done.");
    assert.equal(sends[1].text, `Video notes: Parcel update (12 s)\n\n${NOTES.slice(NOTES.indexOf("## Summary"))}`);
    assert.equal(sends[1].reply_markup?.inline_keyboard[0][0].callback_data, "cap:save");
    assert.equal(chatTurns().length, 0, "a video is not a chat turn");
    assert.ok(logs.some((line) => line.includes("\"telegram_video\"")) && !logs.some((line) => line.includes("parcel arrives")));
});

await check("Telegram webhook: no video model, over 20 MB or one already running is turned down before anything downloads", async () => {
    setCatalogueSnapshotForTests(VIDEO_ROWS.filter((row) => row.traits?.video !== true));
    try { await webhook.POST(videoMessage(502)); } finally { setCatalogueSnapshotForTests(VIDEO_ROWS); }
    assert.deepEqual(telegramSends("sendMessage").map(sentText).map(({ text }) => text), ["Video summaries are unavailable right now: no approved model can read video."]);

    await webhook.POST(videoMessage(503, { video: { file_id: "video-big", duration: 300, file_size: 21 * 1024 * 1024 } }));
    assert.match(telegramSends("sendMessage").map(sentText).at(-1)!.text, /over 20 MB/);

    const release = acquireSlot("video")!;
    try { await webhook.POST(videoMessage(504)); } finally { release(); }
    assert.equal(telegramSends("sendMessage").map(sentText).at(-1)!.text, "I am already summarising a video. Send this one again when that one is done.");
    assert.equal(telegramSends("getFile").length, 0);
    assert.equal(chatTurns().length, 0);
});

await check("Telegram: Save to Capture stores video notes under their title", async () => {
    captureRows.clear();
    await webhook.POST(telegramUpdate(505, { callback_query: { id: "cb-505", from: { id: 1001 }, data: "cap:save",
        message: { message_id: 78, chat: { id: 1001 }, text: "Video notes: Parcel update (12 s)\n\n## Summary\nA card says RIVER." } } }));
    assert.deepEqual(captureRows.get(transcriptCaptureId(1001, 78))!.source, { kind: "text", title: "Parcel update", text: "## Summary\nA card says RIVER." });
    assert.equal(sentText(telegramSends("answerCallbackQuery")[0]).text, "Saved to Capture for review.");
});

log(`${passed} video capture checks passed`);
