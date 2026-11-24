// Offline checks for V8 F8 briefings and F9 translation: command parsing, the briefing facts and script cap, speech
// that falls back to text, translation-model eligibility, pieces retried on the chat route, Free only, and replies.
// Every model call and data source is a fake; no live services or database.
import assert from "node:assert/strict";
import type { CatalogueRow } from "../src/lib/ai/catalogue/snapshot";
import type { ResolvedChat } from "../src/lib/ai/providers";
import type { BriefSources } from "../src/lib/ai/brief";
import type { TranslateDeps } from "../src/lib/ai/translate";
import type { ResolvedEmbedding } from "../src/lib/ai/embeddings";
import type { SingleTurn } from "../src/lib/ai/models/consult";
import type { MediaResult } from "../src/lib/ai/media/requests";

// The chat modules build a Supabase client on import; nothing here reaches it.
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://brief.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture", SUPABASE_SERVICE_ROLE_KEY: "fixture", GEMINI_API_KEY: "fixture", AUTH_SESSION_SECRET: "fixture", APP_TIMEZONE: "Australia/Sydney" });
delete process.env.TTS_SERVICE_URL;
delete process.env.MEDIA_KINDS;
const { PROVIDERS, providers } = await import("../src/lib/ai/providers");
const { setCatalogueSnapshotForTests } = await import("../src/lib/ai/catalogue/snapshot");
const { setMediaChoicesForTests } = await import("../src/lib/ai/media/choices");
const { resolveModelOfKind } = await import("../src/lib/ai/media/resolve");
const { parseDirectCommand, runDirectCommand } = await import("../src/lib/ai/direct-commands");
const { BRIEF_MAX_CHARS, briefChats, briefPrompt, clampScript, dueWhen, eventWhen, gatherBriefFacts, writeBrief } = await import("../src/lib/ai/brief");
const { findLanguage, guessSource, listsLanguage, looksCut, PIECE_CHARS, splitForTranslation, translateText, translationCredit, TRANSLATE_MAX_CHARS } = await import("../src/lib/ai/translate");
const { briefingVoicePlan, replyVoicePlan } = await import("../src/lib/ai/tts");
const { expandSlashCommand, matchSlashCommands } = await import("../src/lib/commands");
const { CHANNEL_COMMANDS } = await import("../src/lib/messaging/channel-threads");
const { translateReplyRef } = await import("../src/lib/messaging/telegram-turn");
const { parseReplyRef } = await import("../src/lib/types");

for (const provider of PROVIDERS) process.env[provider.apiKeyEnv] = "brief-test-key";
setMediaChoicesForTests({});

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

const chat = (): ResolvedChat => {
    const provider = providers().find((entry) => entry.id === "nvidia-nim")!;
    return { provider, model: provider.chatModels.find((model) => model.id === "z-ai/glm-5.3-flash")! };
};
const embRef = {} as ResolvedEmbedding;

const RIVA = "nvidia/riva-translate-4b-instruct-v2";
function row(overrides: Partial<CatalogueRow> = {}): CatalogueRow {
    return {
        providerId: "nvidia-nim", modelId: RIVA, kind: "translate", origin: "seed", label: "Riva Translate 4B (free)", shortName: "riva-translate-4b-instruct-v2",
        description: null, developer: null, free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: ["Text"], listedTools: null,
        listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-25T00:00:00.000Z", probeChatMs: 900,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null, firstSeenAt: "2026-11-24T00:00:00.000Z",
        lastSeenAt: "2026-11-25T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null, approvedAt: "2026-11-25T00:00:00.000Z",
        dimension: null, expiresAt: null, expiresSource: null, notifiedExpiryDays: null, expiryCheckedAt: null, spaceOf: null,
        traits: { languages: ["en", "vi", "zh-cn"], promptTemplate: "Translate from {source} to {target}:\n{text}" },
        ...overrides,
    };
}

const ENGLISH = "The tutorial moved to Thursday at 15:30 in room 204. Bring the printed notes and your laptop.";
function translator(options: { failOn?: (text: string) => boolean } = {}) {
    const modelCalls: { text: string; source: string; target: string; template?: string }[] = [];
    const chatCalls: string[] = [];
    const deps: TranslateDeps = {
        resolve: (freeOnly, filter) => resolveModelOfKind("translate", { freeOnly, filter }),
        model: async (_route, input): Promise<MediaResult<string>> => {
            modelCalls.push(input);
            if (options.failOn?.(input.text)) return { ok: false, status: null, ms: 20_000, error: "No answer within 20 s.", transient: true, timedOut: true, retiredAt: null };
            return { ok: true, status: 200, ms: 800, value: `[model ${input.target}] ${input.text}` };
        },
        chat: async (text, target) => { chatCalls.push(text); return `[chat ${target.name}] ${text}`; },
        chatLabel: "GLM 5.3 Flash",
    };
    return { deps, modelCalls, chatCalls };
}

await check("commands parse on every channel and the web drop-up lists them without expanding them", () => {
    assert.deepEqual(parseDirectCommand("/brief"), { kind: "brief", study: false });
    assert.deepEqual(parseDirectCommand("/brief@ZuychinBot study"), { kind: "brief", study: true });
    assert.deepEqual(parseDirectCommand("!brief STUDY please"), { kind: "brief", study: true });
    assert.deepEqual(parseDirectCommand("/translate vi Good morning"), { kind: "translate", language: "vi", text: "Good morning" });
    assert.deepEqual(parseDirectCommand("/translate into French\nLine one\nLine two"), { kind: "translate", language: "French", text: "Line one\nLine two" });
    assert.deepEqual(parseDirectCommand("/translate"), { kind: "translate", language: "", text: "" });
    assert.equal(parseDirectCommand("/briefing"), null);
    assert.equal(parseDirectCommand("please /brief"), null);
    assert.equal(expandSlashCommand("/brief"), null, "direct commands are not prompt expansions");
    assert.deepEqual(matchSlashCommands("/br").map((command) => command.id), ["brief"]);
    assert.ok(matchSlashCommands("/tr").some((command) => command.id === "translate"));
    assert.ok(CHANNEL_COMMANDS.some((command) => command.command === "brief") && CHANNEL_COMMANDS.some((command) => command.command === "translate"));
});

await check("languages, source guesses and listed languages", () => {
    assert.equal(findLanguage("VI")?.name, "Vietnamese");
    assert.equal(findLanguage("vietnamese")?.code, "vi");
    assert.equal(findLanguage("Tiếng Việt")?.code, "vi");
    assert.equal(findLanguage("mandarin")?.code, "zh");
    assert.equal(findLanguage("klingon"), null);
    assert.equal(guessSource(ENGLISH)?.code, "en");
    assert.equal(guessSource("Buổi học chuyển sang thứ Năm lúc 15:30 tại phòng 204.")?.code, "vi");
    assert.equal(guessSource("会議は木曜日の15時30分です。"), null);
    assert.equal(guessSource("12:30 / 45"), null);
    assert.ok(listsLanguage(row(), "zh"), "a regional code counts for its base language");
    assert.ok(!listsLanguage(row(), "fr"));
});

await check("long text is split at paragraph breaks into pieces the model can take", () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Paragraph ${index + 1}. ${"Words go here. ".repeat(40)}`.trim());
    const pieces = splitForTranslation(paragraphs.join("\n\n"));
    assert.ok(pieces.length >= 3 && pieces.every((piece) => piece.length <= PIECE_CHARS), pieces.map((piece) => piece.length).join(","));
    assert.equal(pieces.join("\n\n").replace(/\s+/g, " "), paragraphs.join(" ").replace(/\s+/g, " "), "nothing is lost or reordered");
    const long = splitForTranslation(`${"A long sentence that keeps going. ".repeat(80)}`.trim());
    assert.ok(long.length >= 2 && long.every((piece) => piece.length <= PIECE_CHARS && /\.$/.test(piece)), "a long paragraph is cut at sentence ends");
    assert.deepEqual(splitForTranslation("  \n\n "), []);
});

await check("the translation model is used only when approved, passed and listing both languages", async () => {
    const vi = findLanguage("vi")!, fr = findLanguage("fr")!;
    setCatalogueSnapshotForTests([row()]);
    const used = translator();
    const result = await translateText(ENGLISH, vi, { freeOnly: false }, used.deps);
    assert.equal(used.modelCalls.length, 1);
    assert.deepEqual({ ...used.modelCalls[0], text: undefined }, { text: undefined, source: "English", target: "Vietnamese", template: "Translate from {source} to {target}:\n{text}" });
    assert.equal(result.text, `[model Vietnamese] ${ENGLISH}`);
    assert.equal(translationCredit(result), "Vietnamese translation by Riva Translate 4B (free).");

    for (const [name, rows, target, text] of [
        ["target not listed", [row()], fr, ENGLISH],
        ["unapproved", [row({ approvedAt: null })], vi, ENGLISH],
        ["probe not passed", [row({ probeStatus: "failed" })], vi, ENGLISH],
        ["no translate row", [], vi, ENGLISH],
        ["unknown source", [row()], vi, "会議は木曜日の15時30分です。"],
        ["same language", [row()], findLanguage("en")!, ENGLISH],
    ] as const) {
        setCatalogueSnapshotForTests(rows);
        const fallback = translator();
        const translated = await translateText(text, target, { freeOnly: false }, fallback.deps);
        assert.equal(fallback.modelCalls.length, 0, name);
        assert.equal(fallback.chatCalls.length, 1, name);
        assert.match(translationCredit(translated), / translation by GLM 5\.3 Flash\.$/, name);
    }
});

await check("Free only uses only a free translation model", async () => {
    const vi = findLanguage("vi")!;
    setCatalogueSnapshotForTests([row({ free: false, label: "Riva Translate 4B" })]);
    const paid = translator();
    await translateText(ENGLISH, vi, { freeOnly: true }, paid.deps);
    assert.deepEqual([paid.modelCalls.length, paid.chatCalls.length], [0, 1]);
    const outside = translator();
    await translateText(ENGLISH, vi, { freeOnly: false }, outside.deps);
    assert.deepEqual([outside.modelCalls.length, outside.chatCalls.length], [1, 0], "the paid model is fine outside Free only");
    setCatalogueSnapshotForTests([row()]);
});

await check("a piece the model fails is retried on the chat route and the credit says so", async () => {
    setCatalogueSnapshotForTests([row()]);
    const text = ["First paragraph of the notes. ".repeat(30), "Second paragraph is the one that fails. ".repeat(30), "Third paragraph closes the notes. ".repeat(30)].map((part) => part.trim()).join("\n\n");
    const flaky = translator({ failOn: (piece) => piece.startsWith("Second") });
    const quiet = console.warn;
    console.warn = () => {};
    let result;
    try { result = await translateText(text, findLanguage("vi")!, { freeOnly: false }, flaky.deps); }
    finally { console.warn = quiet; }
    assert.equal(result.pieces, 3);
    assert.equal(result.byModel, 2);
    assert.equal(flaky.chatCalls.length, 1);
    assert.ok(flaky.chatCalls[0].startsWith("Second"));
    const parts = result.text.split("\n\n");
    assert.deepEqual(parts.map((part) => part.slice(0, 18)), ["[model Vietnamese]", "[chat Vietnamese] ", "[model Vietnamese]"], "order is kept");
    assert.equal(translationCredit(result), "Vietnamese translation by Riva Translate 4B (free), with 1 of 3 parts by GLM 5.3 Flash after the translation model failed.");
});

await check("the model gets one paragraph per call, a cut answer goes to chat, and many paragraphs skip the model", async () => {
    setCatalogueSnapshotForTests([row()]);
    const vi = findLanguage("vi")!;
    const short = ["The check-in moved to Thursday at 15:30.", "Lena presents the retrieval results first.", "The reflection is due Friday at 11:59 pm."].join("\n\n");
    const split = translator();
    const result = await translateText(short, vi, { freeOnly: false }, split.deps);
    assert.deepEqual(split.modelCalls.map((call) => call.text.slice(0, 8)), ["The chec", "Lena pre", "The refl"]);
    assert.equal(result.text.split("\n\n").length, 3);

    const cutting = translator();
    cutting.deps.model = async (_route, input) => {
        cutting.modelCalls.push(input);
        return { ok: true, status: 200, ms: 800, value: input.text.startsWith("Lena") ? "Lena." : `[model] ${input.text}` };
    };
    const quiet = console.warn;
    console.warn = () => {};
    let cut;
    try { cut = await translateText(short, vi, { freeOnly: false }, cutting.deps); }
    finally { console.warn = quiet; }
    assert.deepEqual([cut.byModel, cutting.chatCalls.length], [2, 1]);
    assert.ok(cutting.chatCalls[0].startsWith("Lena"));
    assert.ok(looksCut("A sentence of forty characters or so ok.", "会議", findLanguage("fr")!));
    assert.ok(!looksCut("A sentence of forty characters or so ok.", "四十字左右的句子", findLanguage("zh")!), "compact scripts are allowed to be short");

    const many = translator();
    const notes = Array.from({ length: 30 }, (_, index) => `Point ${index + 1} is a short line of the notes.`).join("\n\n");
    const grouped = await translateText(notes, vi, { freeOnly: false }, many.deps);
    assert.deepEqual([many.modelCalls.length, many.chatCalls.length], [0, 1]);
    assert.match(translationCredit(grouped), /by GLM 5\.3 Flash\.$/);
});

const briefSources = (overrides: Partial<BriefSources> = {}): BriefSources => ({
    events: async () => [
        { summary: "Capstone meeting", start: "2026-11-25T03:00:00.000Z", end: "2026-11-25T04:00:00.000Z", location: "Room B204" },
        { summary: "Public holiday", start: "2026-11-26" },
    ],
    dueTodos: async () => [{ title: "Submit reflection", priority: "high", dueDate: "2026-11-24" }, { title: "Pay phone bill", priority: "medium", dueDate: "2026-11-25T06:00:00.000Z" }],
    openTodos: async () => [{ title: "Submit reflection", priority: "high", dueDate: "2026-11-24" }, { title: "Book dentist", priority: "low", dueDate: null }],
    captures: async () => [
        { title: "Lecture on retrieval", createdAt: "2026-11-24T23:00:00.000Z", saved: false },
        { title: "Old link", createdAt: "2026-11-20T00:00:00.000Z", saved: false },
        { title: "Saved note", createdAt: "2026-11-24T22:00:00.000Z", saved: true },
    ],
    studyDue: async () => 7,
    studyCards: async () => [{ deck: "SIT764", prompt: "What is retrieval augmented generation?" }, { deck: "SIT764", prompt: "Define reranking." }, { deck: "Statistics", prompt: "What is a p-value?" }],
    ...overrides,
});
// 10:30 on 25/11/2026 in Sydney (AEDT, UTC+11).
const NOW = new Date("2026-11-24T23:30:00.000Z");

await check("briefing facts are read, dated in the app's timezone and survive a failing source", async () => {
    assert.equal(eventWhen({ summary: "x", start: "2026-11-25T03:00:00.000Z", end: "2026-11-25T04:00:00.000Z" }, NOW), "today 2:00 pm to 3:00 pm");
    assert.equal(eventWhen({ summary: "x", start: "2026-11-26" }, NOW), "tomorrow, all day");
    assert.equal(dueWhen("2026-11-24", NOW), "overdue");
    assert.equal(dueWhen("2026-11-25", NOW), "due today");
    assert.equal(dueWhen("2026-11-24T12:00:00.000Z", NOW), "overdue");
    const facts = await gatherBriefFacts(briefSources(), { study: false, now: NOW });
    assert.match(facts.now, /^Wednesday 25 November, 10:30 am$/);
    assert.deepEqual(facts.events, [{ when: "today 2:00 pm to 3:00 pm", title: "Capstone meeting", place: "Room B204" }, { when: "tomorrow, all day", title: "Public holiday" }]);
    assert.deepEqual(facts.dueTasks.map((task) => task.due), ["overdue", "due today 5:00 pm"]);
    assert.deepEqual(facts.otherTasks, [{ title: "Book dentist", priority: "low" }], "a due task is not repeated");
    assert.deepEqual(facts.newCaptures, { count: 1, titles: ["Lecture on retrieval"] });
    assert.deepEqual(facts.study, { reviewsDue: 7 });
    assert.deepEqual(facts.unavailable, []);
    const broken = await gatherBriefFacts(briefSources({ events: async () => { throw new Error("calendar down"); }, studyDue: async () => { throw new Error("no study"); } }), { study: false, now: NOW });
    assert.deepEqual(broken.events, []);
    assert.equal(broken.study, null);
    assert.deepEqual(broken.unavailable, ["calendar", "Study"]);
    assert.match(briefPrompt(broken, false), /"unavailable":\["calendar","Study"\]/);
    const study = await gatherBriefFacts(briefSources(), { study: true, now: NOW });
    assert.deepEqual(study.study, { reviewsDue: 7, decks: [{ deck: "SIT764", cards: 2 }, { deck: "Statistics", cards: 1 }], topics: ["What is retrieval augmented generation?", "Define reranking.", "What is a p-value?"] });
    assert.match(briefPrompt(study, true), /This is a study recap/);
    assert.doesNotMatch(briefPrompt(facts, false), /study recap/);
});

await check("the script is plain text, capped for one spoken reply, and written as a summary call", async () => {
    const sentence = "**Next** you have the capstone meeting at two in the afternoon in room B204. ";
    const long = clampScript(sentence.repeat(40));
    assert.ok(long.length <= BRIEF_MAX_CHARS && long.endsWith("."), String(long.length));
    assert.ok(!long.includes("**"));
    assert.equal(clampScript("Short and fine."), "Short and fine.");
    const turns: SingleTurn[] = [];
    const written = await writeBrief({ chats: [chat()], embRef, study: false, facts: await gatherBriefFacts(briefSources(), { study: false, now: NOW }) },
        async (_chat, turn) => { turns.push(turn); return sentence.repeat(40); });
    assert.ok(written.script.length <= BRIEF_MAX_CHARS);
    assert.equal(written.model, chat().model.label);
    assert.equal(turns[0].purpose, "summary");
    assert.match(turns[0].system, /reads aloud/);
    await assert.rejects(writeBrief({ chats: [chat()], embRef, study: false, facts: await gatherBriefFacts(briefSources(), { study: false, now: NOW }) }, async () => "   "), /empty/);
});

await check("briefings use only free routes: other free Gemini models first, then one other provider, never a preview", async () => {
    const gemini = providers().find((entry) => entry.id === "gemini")!;
    const paid: ResolvedChat = { provider: gemini, model: gemini.chatModels.find((model) => model.free !== true)! };
    const routes = briefChats(paid);
    const [first, second] = routes;
    const ids = routes.map((route) => `${route.provider.id}::${route.model.id}`);
    assert.equal(first.provider.id, "gemini-free", `a paid pick is swapped for the first free route: ${ids.join(", ")}`);
    assert.ok(routes.every((route) => route.model.free === true), ids.join(", "));
    assert.ok(routes.slice(1).every((route) => !/preview/i.test(route.model.id)), `no preview fallbacks: ${ids.join(", ")}`);
    assert.equal(new Set(ids).size, ids.length, "no route twice");
    assert.ok(routes.length <= 4);
    assert.equal(second.provider.kind, "gemini", "another free Gemini model is tried next");
    assert.notEqual(routes.at(-1)!.provider.kind, "gemini", "the last resort is another provider");
    const fromNim = briefChats(chat());
    assert.equal(fromNim[0].model.id, chat().model.id, "a free pick is kept");
    assert.ok(fromNim.slice(1).every((route) => route.provider.id !== "nvidia-nim"), `fallbacks leave the failed provider: ${fromNim.map((route) => route.provider.id).join(", ")}`);

    const facts = await gatherBriefFacts(briefSources(), { study: false, now: NOW });
    const tried: string[] = [];
    const written = await writeBrief({ chats: [first, second], embRef, study: false, facts }, async (route) => {
        tried.push(route.provider.id);
        if (route === first) throw new Error("503 high demand");
        return "Good morning.";
    });
    assert.deepEqual(tried, [first.provider.id, second.provider.id]);
    assert.deepEqual(written, { script: "Good morning.", model: second.model.label });
    await assert.rejects(writeBrief({ chats: [first, second], embRef, study: false, facts }, async () => { throw new Error("503 high demand"); }), /503/);

    const stopped = new AbortController();
    stopped.abort();
    let calls = 0;
    await assert.rejects(writeBrief({ chats: [first, second], embRef, study: false, facts, signal: stopped.signal }, async () => { calls++; throw new Error("aborted"); }), /aborted/);
    assert.equal(calls, 1, "a stopped briefing tries no second route");
});

await check("a /brief reply is spoken whatever the reply preference says, only by free voices, and stays text without one", () => {
    const off = { voice: { replyWithVoice: "off", speechEngine: "auto" } };
    assert.equal(replyVoicePlan(off, { audioTurn: false, freeOnly: false }), null, "ordinary replies follow the preference");
    assert.equal(replyVoicePlan({ voice: { replyWithVoice: "always", speechEngine: "auto" } }, { audioTurn: false, freeOnly: false })?.api?.route.providerId, "gemini",
        "ordinary replies may use the paid voice");
    assert.equal(replyVoicePlan({ voice: { replyWithVoice: "always", speechEngine: "auto" } }, { audioTurn: false, freeOnly: true }), null,
        "ordinary Free only replies on Telegram and Discord still never use a free API voice");
    assert.equal(briefingVoicePlan(off)?.api?.route.providerId, "gemini-free", "no on-box voice: the free Gemini key, never the paid voice");
    assert.equal(briefingVoicePlan(off)?.local, null);
    process.env.TTS_SERVICE_URL = "http://127.0.0.1:9";
    process.env.TTS_SERVICE_TOKEN = "fixture";
    const freeKey = process.env.GEMINI_FREE_API_KEY;
    try {
        const plan = briefingVoicePlan(off);
        assert.equal(plan?.local, "M2", "the on-box voice speaks first");
        assert.equal(plan?.api?.route.providerId, "gemini-free", "with a free API voice behind it");
        assert.equal(briefingVoicePlan({ voice: { replyWithVoice: "off", speechEngine: "local" } })?.api, null, "a forced on-box voice keeps no fallback");
        delete process.env.GEMINI_FREE_API_KEY;
        assert.deepEqual(briefingVoicePlan(off), { local: "M2", api: null }, "without the free key only the on-box voice is left");
    } finally {
        delete process.env.TTS_SERVICE_URL; delete process.env.TTS_SERVICE_TOKEN;
        process.env.GEMINI_FREE_API_KEY = freeKey;
    }
    assert.equal(briefingVoicePlan(off)?.api?.route.providerId, "gemini-free");
});

const direct = (deps: TranslateDeps, replyTo?: { role: "user" | "assistant"; content: string }) => ({
    chat: chat(), embRef, freeOnly: false, replyTo, briefSources: () => briefSources(), translateDeps: () => deps,
});

await check("/translate answers from its text, the replied message, or with its usage", async () => {
    setCatalogueSnapshotForTests([row()]);
    const usage = translator();
    assert.match((await runDirectCommand({ kind: "translate", language: "", text: "" }, direct(usage.deps))).reply, /^Use \/translate <language> <text>/);
    assert.match((await runDirectCommand({ kind: "translate", language: "klingon", text: "hi" }, direct(usage.deps))).reply, /^I don't know the language "klingon"/);
    assert.match((await runDirectCommand({ kind: "translate", language: "vi", text: "" }, direct(usage.deps))).reply, /^There is nothing to translate/);
    assert.match((await runDirectCommand({ kind: "translate", language: "vi", text: "x".repeat(TRANSLATE_MAX_CHARS + 1) }, direct(usage.deps))).reply, /too long to translate here \(8,001 characters; the limit is 8,000\)/);
    assert.equal(usage.modelCalls.length + usage.chatCalls.length, 0, "no model call for a refused request");

    const replied = translator();
    const fromReply = await runDirectCommand({ kind: "translate", language: "vi", text: "" }, direct(replied.deps, { role: "assistant", content: ENGLISH }));
    assert.equal(fromReply.speak, false);
    assert.equal(fromReply.reply, `[model Vietnamese] ${ENGLISH}\n\n_Vietnamese translation by Riva Translate 4B (free)._`);
    const own = translator();
    await runDirectCommand({ kind: "translate", language: "vi", text: "Thanks for the reminder, see you on Thursday." }, direct(own.deps, { role: "user", content: ENGLISH }));
    assert.equal(own.modelCalls[0].text, "Thanks for the reminder, see you on Thursday.", "typed text wins over the replied message");
});

await check("/brief returns the capped script with the speak flag, and a study recap asks for one", async () => {
    const prompts: string[] = [];
    const generate = async (_chat: ResolvedChat, turn: SingleTurn) => { prompts.push(turn.prompt); return "Good morning. You have the capstone meeting at two."; };
    const day = await runDirectCommand({ kind: "brief", study: false }, { ...direct(translator().deps), generate });
    assert.deepEqual(day, { reply: "Good morning. You have the capstone meeting at two.", speak: true });
    await runDirectCommand({ kind: "brief", study: true }, { ...direct(translator().deps), generate });
    assert.doesNotMatch(prompts[0], /study recap/);
    assert.match(prompts[1], /This is a study recap/);
    assert.match(prompts[1], /"decks":\[\{"deck":"SIT764","cards":2\}/);

    const gemini = providers().find((entry) => entry.id === "gemini")!;
    const routes: string[] = [];
    const free = briefChats(null);
    await runDirectCommand({ kind: "brief", study: false }, {
        ...direct(translator().deps), chat: { provider: gemini, model: gemini.chatModels.find((model) => model.free !== true)! }, briefChats: free,
        generate: async (route: ResolvedChat) => { routes.push(route.model.id); return "Hi."; },
    });
    assert.deepEqual(routes, [free[0].model.id], "the briefing is written on its free route, not the request's chat model");
});

await check("replies to translate arrive from Telegram and the web as quotes", () => {
    assert.deepEqual(translateReplyRef("/translate vi", { text: "Hello there", from: { is_bot: true } }), { role: "assistant", content: "Hello there" });
    assert.deepEqual(translateReplyRef("/translate@ZuychinBot fr", { caption: "Photo caption", from: { is_bot: false } }), { role: "user", content: "Photo caption" });
    assert.equal(translateReplyRef("what does this mean?", { text: "Hello" }), undefined, "other replies keep today's behaviour");
    assert.equal(translateReplyRef("/translate vi", undefined), undefined);
    assert.equal(translateReplyRef("/translate vi", { text: "  " }), undefined);
    assert.deepEqual(parseReplyRef({ role: "user", content: "x".repeat(2500) })?.content.length, 2000);
    assert.equal(parseReplyRef({ role: "system", content: "x" }), undefined);
});

console.log(`${checks} briefing and translation checks passed`);
