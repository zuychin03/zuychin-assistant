// Offline checks for V8 F14 decisions: the request, every null fallback, the router, the memory gate against the
// 20 recorded fixture turns, and the untrusted-content note. Every request goes to a fake fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, resolveDecider } from "../src/lib/ai/decisions";
import { classifyIntent, routeInput, routeQuestions } from "../src/lib/ai/agent/router";
import { gatedMemoryExtraction, gateInput, gateVerdict, INJECTED_AT, MEMORY_GATE_QUESTIONS, REMEMBER_BELOW, untrustedNote, worthExtracting, type GateTurn } from "../src/lib/ai/memory/gate";
import { describeUntrusted } from "../src/lib/ai/reply-notes";
import { fetchedContent, recordFetchedContent, withReplySources } from "../src/lib/ai/reply-sources";
import { makeReplyTrace, mergeReplyTrace } from "../src/lib/ai/reply-trace";
import { collectModelObservations, configureModelDataPolicy } from "../src/lib/ai/model-observations";
import { setCatalogueSnapshotForTests, type CatalogueRow } from "../src/lib/ai/catalogue/snapshot";
import { setMediaChoicesForTests } from "../src/lib/ai/media/choices";
import { getProvider } from "../src/lib/ai/providers";
import type { ResolvedMedia } from "../src/lib/ai/media/resolve";
import type { DecisionAnswer } from "../src/lib/ai/media/requests";

let checks = 0;
async function check(name: string, run: () => Promise<void> | void) {
    await run();
    checks++;
    console.log(`PASS ${name}`);
}

function row(overrides: Partial<CatalogueRow> = {}): CatalogueRow {
    return {
        providerId: "gemini-free", modelId: "gemini-decision-1", kind: "decision", origin: "seed", label: "Gemini Decision 1 (free)", shortName: "gemini-decision-1-free",
        description: null, developer: null, free: true, metered: false, mayTrain: null, contextTokens: null, maxOutputTokens: null, inputs: [], listedTools: null,
        listedStructured: null, listedThinking: null, probeStatus: "passed", probeAttempts: 0, probedAt: "2026-11-24T00:00:00.000Z", probeChatMs: 400,
        supportsTools: null, supportsSearch: null, supportsVision: null, supportsThinking: null, supportsStructured: null, firstSeenAt: "2026-11-20T00:00:00.000Z",
        lastSeenAt: "2026-11-24T00:00:00.000Z", missedChecks: 0, missingSince: null, notifiedMissingAt: null, approvedAt: "2026-11-24T00:00:00.000Z",
        dimension: null, expiresAt: null, expiresSource: null, notifiedExpiryDays: null, expiryCheckedAt: null, spaceOf: null, traits: {},
        ...overrides,
    };
}
const paidRow = () => row({ providerId: "gemini", free: false, metered: true, label: "Gemini Decision 1", shortName: "gemini-decision-1" });
const resolved = (entry = row()): ResolvedMedia => ({ provider: getProvider(entry.providerId)!, row: entry, modelId: entry.modelId, apiKey: "fixture-key" });

type Call = { url: string; headers: Headers; body: { model: string; input: string; questions: Record<string, { type: string; instructions: string; criteria?: unknown }> } };
function answering(answers: Record<string, unknown>, calls: Call[] = [], status = 200): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(status === 200 ? { answers } : { error: { message: "unavailable" } }), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
}
const hang: typeof fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) return reject(init.signal.reason);
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
})) as typeof fetch;
async function alive<T>(work: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {}, 20);
    try { return await work(); } finally { clearInterval(timer); }
}
const noul = (value: number): DecisionAnswer => ({ type: "noul", value, confidence: null });

await check("decide sends the model, the input and the questions, and returns typed answers", async () => {
    const calls: Call[] = [];
    const decided = await decide("  User message:\nhello there  ", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(), fetchImpl: answering({ remember: { noul: 0.91 }, injected: { noul: 0.02, confidence: 0.8 } }, calls) });
    assert.ok(decided);
    assert.deepEqual(decided.answers, { remember: noul(0.91), injected: { type: "noul", value: 0.02, confidence: 0.8 } });
    assert.equal(decided.model, "Gemini Decision 1 (free)");
    assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/decisions");
    assert.equal(calls[0].headers.get("x-goog-api-key"), "fixture-key");
    assert.equal(calls[0].body.model, "gemini-decision-1");
    assert.equal(calls[0].body.input, "User message:\nhello there");
    assert.deepEqual(Object.keys(calls[0].body.questions), ["remember", "injected"]);
    const long = await decide("x".repeat(20_000), MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(), fetchImpl: answering({ remember: { noul: 0 }, injected: { noul: 0 } }, calls) });
    assert.ok(long);
    assert.equal(calls[1].body.input.length, 12_000);
});

await check("decide returns null for no model, empty input, a failure, a missing answer and a timeout", async () => {
    const calls: Call[] = [];
    assert.equal(await decide("text", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: null, fetchImpl: answering({}, calls) }), null);
    assert.equal(await decide("   ", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(), fetchImpl: answering({}, calls) }), null);
    assert.equal(calls.length, 0, "nothing is sent without a model or an input");
    assert.equal(await decide("text", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(), fetchImpl: answering({}, [], 503) }), null);
    assert.equal(await decide("text", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(), fetchImpl: answering({ remember: { noul: 0.4 } }) }), null, "every question must be answered");
    assert.equal(await decide("text", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(), fetchImpl: answering({ remember: { noul: 1.4 }, injected: { noul: 0 } }) }), null, "a probability outside 0..1 is not used");
    const started = performance.now();
    assert.equal(await alive(() => decide("text", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(), fetchImpl: hang, timeoutMs: 80 })), null);
    assert.ok(performance.now() - started < 1_000);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(decide("text", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(), fetchImpl: hang, signal: controller.signal }));
});

await check("the call is observed as a decision; Free only never sends to the paid key", async () => {
    setCatalogueSnapshotForTests([row(), paidRow()]);
    const sent: Call[] = [];
    const observed = await collectModelObservations(async () => {
        configureModelDataPolicy(false);
        return decide("text", MEMORY_GATE_QUESTIONS, { freeOnly: false, route: resolved(paidRow()), fetchImpl: answering({ remember: { noul: 0.5 }, injected: { noul: 0.1 } }, sent) });
    }, ["personal"]);
    assert.ok(observed.value);
    assert.deepEqual(observed.observations.map((entry) => [entry.purpose, entry.providerId, entry.status, entry.dataRoute?.tier]), [["decision", "gemini", "success", "paid"]]);
    const refused = await collectModelObservations(async () => {
        configureModelDataPolicy(true);
        return decide("text", MEMORY_GATE_QUESTIONS, { freeOnly: true, route: resolved(paidRow()), fetchImpl: answering({ remember: { noul: 0.5 }, injected: { noul: 0.1 } }, sent) });
    }, ["personal"]);
    assert.equal(refused.value, null);
    assert.equal(sent.length, 1);
    setCatalogueSnapshotForTests([]);
});

await check("resolution: the paid key in normal mode, the free key in Free only, nothing when MEDIA_KINDS=off", async () => {
    const saved = { paid: process.env.GEMINI_API_KEY, free: process.env.GEMINI_FREE_API_KEY, kinds: process.env.MEDIA_KINDS };
    process.env.GEMINI_API_KEY = "fixture-paid";
    process.env.GEMINI_FREE_API_KEY = "fixture-free";
    delete process.env.MEDIA_KINDS;
    setMediaChoicesForTests({});
    try {
        setCatalogueSnapshotForTests([row(), paidRow()]);
        assert.equal((await resolveDecider(false))?.provider.id, "gemini");
        assert.equal((await resolveDecider(true))?.provider.id, "gemini-free");
        process.env.MEDIA_KINDS = "off";
        assert.equal(await resolveDecider(false), null);
    } finally {
        for (const [key, value] of [["GEMINI_API_KEY", saved.paid], ["GEMINI_FREE_API_KEY", saved.free], ["MEDIA_KINDS", saved.kinds]] as const) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        setCatalogueSnapshotForTests([]);
    }
});

await check("router: the decision model's choice wins, quick messages never ask it, and context goes with a continuation", async () => {
    const asked: { input: string; continuation: boolean }[] = [];
    const answer = (choice: "chat" | "agent"): typeof decide => (async (input: string, questions: Record<string, unknown>) => {
        asked.push({ input, continuation: JSON.stringify(questions).includes("previous message") });
        return { answers: { mode: { type: "choice", value: choice, probabilities: { [choice]: 0.97 }, confidence: null } }, model: "fixture", ms: 5 };
    }) as unknown as typeof decide;
    assert.deepEqual(await classifyIntent("Write a report on solar panel prices with a table", undefined, false, answer("agent")), { mode: "agent" });
    assert.deepEqual(await classifyIntent("Please write me a full research report", undefined, true, answer("chat")), { mode: "chat" }, "the model overrides the Free only keyword rule");
    assert.deepEqual(await classifyIntent("hello there, how are you", undefined, false, answer("agent")), { mode: "chat" });
    assert.deepEqual(await classifyIntent("ok", undefined, false, answer("agent")), { mode: "chat" });
    assert.equal(asked.length, 2, "greetings and short replies are settled before any call");
    await classifyIntent("Both please", "I can draft the cover letter and the CV summary. Want both?", false, answer("agent"));
    assert.ok(asked[2].continuation && asked[2].input.startsWith("The assistant's previous message:\nI can draft"));
    assert.equal(routeInput("hi there friend"), "User message:\nhi there friend");
    assert.deepEqual(Object.keys((routeQuestions(false).mode as { criteria: Record<string, string> }).criteria), ["agent", "chat"]);
});

await check("router: with no answer, Free only keeps the keyword rule and normal mode keeps the generate call", async () => {
    const none = (async () => null) as typeof decide;
    assert.deepEqual(await classifyIntent("Please draft a document about the project budget", undefined, true, none), { mode: "agent" });
    assert.deepEqual(await classifyIntent("What is the tallest mountain in Africa?", undefined, true, none), { mode: "chat" });
    const saved = { fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY };
    const urls: string[] = [];
    process.env.GEMINI_API_KEY = "fixture-paid";
    globalThis.fetch = (async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json({ candidates: [{ content: { parts: [{ text: '{"mode":"agent"}' }] }, finishReason: "STOP" }] });
    }) as typeof fetch;
    try {
        assert.deepEqual(await classifyIntent("What is the tallest mountain in Africa?", undefined, false, none), { mode: "agent" }, "the generate call's answer is used");
        assert.ok(urls.length === 1 && urls[0].includes(":generateContent"));
    } finally {
        globalThis.fetch = saved.fetch;
        if (saved.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.key;
    }
});

interface FixtureTurn extends GateTurn { id: string; expect: { extract: boolean; injected: boolean }; answers?: { remember: number; injected: number } }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/memory-gate-turns.json", import.meta.url), "utf8")) as { recorded: { model: string } | null; turns: FixtureTurn[] };

await check("memory gate: the 20 recorded fixture turns all get the intended outcome at these thresholds", () => {
    assert.equal(fixture.turns.length, 20);
    assert.ok(fixture.recorded, "answers are recorded by scripts/memory-gate-calibrate.mts --write");
    for (const turn of fixture.turns) {
        assert.ok(turn.answers, `${turn.id} has recorded answers`);
        assert.ok(worthExtracting(turn.userMessage), `${turn.id} reaches the gate`);
        const verdict = gateVerdict({ remember: noul(turn.answers.remember), injected: noul(turn.answers.injected) });
        assert.deepEqual(verdict, turn.expect, turn.id);
    }
    const keep = fixture.turns.filter((turn) => turn.expect.extract).map((turn) => turn.answers!.remember);
    const skip = fixture.turns.filter((turn) => !turn.expect.extract && !turn.expect.injected).map((turn) => turn.answers!.remember);
    const flagged = fixture.turns.filter((turn) => turn.expect.injected).map((turn) => turn.answers!.injected);
    const clean = fixture.turns.filter((turn) => !turn.expect.injected).map((turn) => turn.answers!.injected);
    assert.ok(Math.min(...keep) - REMEMBER_BELOW >= 0.2 && REMEMBER_BELOW - Math.max(...skip) >= 0.02, "remember threshold sits between the groups");
    assert.ok(Math.min(...flagged) - INJECTED_AT >= 0.2 && INJECTED_AT - Math.max(...clean) >= 0.2, "injected threshold sits between the groups");
    assert.equal(fixture.turns.filter((turn) => turn.expect.injected).length, 5);
});

await check("memory gate: skip, extract, fallback and the untrusted note", async () => {
    const turn = (extra: Partial<GateTurn> = {}): GateTurn => ({ userMessage: "My brother lives in Hobart and works as a chef.", assistantReply: "Nice!", fetched: [], ...extra });
    const answers = (remember: number, injected: number) => (async () => ({ answers: { remember: noul(remember), injected: noul(injected) }, model: "fixture", ms: 3 })) as unknown as typeof decide;
    let extracted = 0;
    const extract = async () => { extracted++; };
    assert.equal(await gatedMemoryExtraction(turn(), extract, { freeOnly: false, decideImpl: answers(0.95, 0.01) }), null);
    assert.equal(extracted, 1);
    assert.equal(await gatedMemoryExtraction(turn(), extract, { freeOnly: false, decideImpl: answers(0.1, 0.01) }), null);
    assert.equal(extracted, 1, "nothing worth keeping skips the paid extractor");
    const fetched = [{ source: "search results" as const, text: "a" }, { source: "emails" as const, text: "b" }, { source: "search results" as const, text: "c" }];
    const note = await gatedMemoryExtraction(turn({ fetched, attachment: "file" }), extract, { freeOnly: false, decideImpl: answers(0.95, 0.9) });
    assert.deepEqual(note, { sources: ["search results", "emails", "an attached file"] });
    assert.equal(extracted, 1, "injected text skips the extractor even when the turn holds a fact");
    assert.equal(describeUntrusted(note!), "Untrusted content: text in search results, emails or an attached file looked like instructions to the assistant, so nothing from this turn was saved to memory.");
    assert.equal(describeUntrusted(untrustedNote({ fetched: [] })), "Untrusted content: text in your message looked like instructions to the assistant, so nothing from this turn was saved to memory.");
    assert.equal(await gatedMemoryExtraction(turn(), extract, { freeOnly: false, decideImpl: (async () => null) as typeof decide }), null);
    assert.equal(extracted, 2, "no answer keeps the pre-V8 behaviour: the extractor runs");
    let called = 0;
    const counting = (async () => { called++; return null; }) as typeof decide;
    await gatedMemoryExtraction(turn(), extract, { freeOnly: true, decideImpl: counting });
    await gatedMemoryExtraction(turn({ userMessage: "/model fast" }), extract, { freeOnly: false, decideImpl: counting });
    await gatedMemoryExtraction(turn({ userMessage: "ok thanks" }), extract, { freeOnly: false, decideImpl: counting });
    assert.deepEqual([called, extracted], [0, 2], "Free only, commands and short messages never reach the gate or the extractor");
});

await check("gate input labels each source and keeps to size", () => {
    const input = gateInput({ userMessage: ` ${"u".repeat(3000)} `, assistantReply: "r".repeat(3000), attachment: "a".repeat(3000), fetched: [{ source: "emails", text: "Hello from a sender" }] });
    const parts = input.split("\n\n");
    assert.deepEqual(parts.map((part) => part.split("\n")[0]), ["User message:", "Attached file (quoted text):", "Fetched emails (written by others):", "Assistant reply:"]);
    assert.equal(parts[0].length, "User message:\n".length + 2000);
    assert.equal(parts[1].length, "Attached file (quoted text):\n".length + 2000);
    assert.equal(parts[3].length, "Assistant reply:\n".length + 1500);
});

await check("fetched text is collected per turn from outside-content tools only, capped", () => {
    let seen: ReturnType<typeof fetchedContent> = [];
    withReplySources([], () => {
        recordFetchedContent("search_web", `  ${"s".repeat(2500)}  `);
        recordFetchedContent("vault_read", "my own note");
        recordFetchedContent("read_email", "   ");
        for (let index = 0; index < 8; index++) recordFetchedContent("list_calendar_events", `event ${index}`);
        seen = fetchedContent();
        seen.push({ source: "emails", text: "not stored" });
        assert.equal(fetchedContent().length, 6, "callers get a copy");
    });
    assert.equal(seen[0].source, "search results");
    assert.equal(seen[0].text.length, 2000);
    assert.deepEqual(seen.slice(1, 6).map((item) => item.source), Array(5).fill("calendar events"));
    recordFetchedContent("search_web", "outside a turn");
    assert.deepEqual(fetchedContent(), []);
});

await check("the untrusted note joins the saved reply details from background work and survives later saves", () => {
    const base = { origin: "interactive" as const, freeOnly: false, startedAt: "2026-11-24T00:00:00.000Z", durationMs: 10, firstAnswerMs: 5, calls: [], externalServices: [] };
    const first = makeReplyTrace({ ...base, background: "pending" });
    const background = makeReplyTrace({ ...base, background: "complete", untrusted: { sources: ["emails"] } });
    const merged = mergeReplyTrace(first, background);
    assert.deepEqual(merged.untrusted, { sources: ["emails"] });
    assert.deepEqual(mergeReplyTrace(merged, makeReplyTrace({ ...base, background: "complete" })).untrusted, { sources: ["emails"] });
    assert.equal(mergeReplyTrace(first, makeReplyTrace({ ...base, background: "complete" })).untrusted, undefined);
});

console.log(`${checks} decision checks passed`);
