// Offline checks for online councils: seat rules, reply repair, prompts, and the runner against an in-memory council that follows the SQL's round rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedChat } from "../src/lib/ai/providers";
import type { CouncilMessage, CouncilParticipant, CouncilSession } from "../src/lib/council/store";
import { resolveSeats, seatRefusal, DEFAULT_STANCES, type SeatPolicy } from "../src/lib/council/online/seats";
import { firstJsonObject, parseSeatReply, parseVerdict, type ReplyContext } from "../src/lib/council/online/parse";
import { renderTranscript, seatPrompt } from "../src/lib/council/online/prompt";
import {
    acquireOnlineRun, consecutiveFailedRounds, driveOnlineCouncil, turnOrder,
    type AppendInput, type AppendOutcome, type OnlineDeps, type OnlineRun,
} from "../src/lib/council/online/runner";
import { FAILED_PASS_PREFIX } from "../src/lib/council/online/limits";
import type { SeatCallResult } from "../src/lib/council/online/call";

function model(key: string, free = true): ResolvedChat {
    const [providerId, modelId] = key.split("::");
    return {
        provider: { id: providerId, label: providerId, kind: "openai-compatible", apiKeyEnv: "TEST_KEY", chatModels: [], embeddingModels: [] },
        model: { id: modelId, label: `${modelId} label`, name: modelId.split("/").pop()!, free, supportsTools: true, supportsVision: false, supportsThinking: false, supportsSearch: false },
    } as unknown as ResolvedChat;
}
const MODELS = new Map<string, ResolvedChat>([
    ["nim::alpha", model("nim::alpha")],
    ["router::beta", model("router::beta")],
    ["gem::gamma", model("gem::gamma")],
    ["paid::delta", model("paid::delta", false)],
]);
const resolveKey = (key: string) => MODELS.get(key) ?? null;
const OPEN: SeatPolicy = { freeOnly: false, allowPaid: false };

test("seats: removed or unavailable models and bad rosters are refused", () => {
    assert.match(seatRefusal("x::gone", null, OPEN)!, /not in the selectable model list/);
    assert.equal(resolveSeats([{ modelKey: "nim::alpha" }], OPEN, resolveKey).ok, false);
    const six = Array.from({ length: 6 }, () => ({ modelKey: "nim::alpha" }));
    assert.equal(resolveSeats(six, OPEN, resolveKey).ok, false);
    const dup = resolveSeats([{ modelKey: "nim::alpha", name: "a" }, { modelKey: "router::beta", name: "A" }], OPEN, resolveKey);
    assert.equal(dup.ok, false);
    const reserved = resolveSeats([{ modelKey: "nim::alpha", name: "zuychin" }, { modelKey: "router::beta" }], OPEN, resolveKey);
    assert.equal(reserved.ok, false);
    const gone = resolveSeats([{ modelKey: "nim::alpha" }, { modelKey: "x::removed" }], OPEN, resolveKey);
    assert.ok(!gone.ok && /x::removed/.test(gone.error));
});

test("seats: paid models need Allow paid, and Free only always wins", () => {
    const seats = [{ modelKey: "nim::alpha" }, { modelKey: "paid::delta" }];
    const refused = resolveSeats(seats, { freeOnly: false, allowPaid: false }, resolveKey);
    assert.ok(!refused.ok && /Tick Allow paid/.test(refused.error));
    const freeOnly = resolveSeats(seats, { freeOnly: true, allowPaid: true }, resolveKey);
    assert.ok(!freeOnly.ok && /Free only is on/.test(freeOnly.error));
    const allowed = resolveSeats(seats, { freeOnly: false, allowPaid: true }, resolveKey);
    assert.ok(allowed.ok && allowed.seats[1].paid === true);
});

test("seats: names default to the model's short name, made unique, with distinct stances", () => {
    const result = resolveSeats([{ modelKey: "nim::alpha" }, { modelKey: "nim::alpha" }, { modelKey: "router::beta", name: "Critic One" }], OPEN, resolveKey);
    assert.ok(result.ok);
    assert.deepEqual(result.seats.map((s) => s.name), ["alpha", "alpha-2", "Critic-One"]);
    assert.deepEqual(result.seats.map((s) => s.expertise), [DEFAULT_STANCES[0], DEFAULT_STANCES[1], DEFAULT_STANCES[2]]);
    assert.equal(result.seats[0].modelKey, "nim::alpha");
    assert.equal(result.seats[0].source, "picker");
});

function msg(seq: number, speaker: string, intent: string, extra: Partial<CouncilMessage> = {}): CouncilMessage {
    return { seq, round: 2, speaker, role: "agent", addressedTo: "all", intent, replyToSeq: null, body: `body ${seq}`, answered: false, createdAt: "", executionId: null, ...extra };
}
const ctx = (over: Partial<ReplyContext> = {}): ReplyContext => ({
    seat: "alpha", seats: ["alpha", "beta", "gamma"], blind: false,
    messages: [msg(2, "beta", "propose"), msg(3, "gamma", "propose"), msg(4, "beta", "challenge", { addressedTo: "alpha", replyToSeq: 2 })],
    openToYou: [msg(4, "beta", "challenge", { addressedTo: "alpha", replyToSeq: 2 })],
    ...over,
});

test("parse: finds the JSON object inside fences and prose", () => {
    assert.deepEqual(firstJsonObject("Sure!\n```json\n{\"a\": {\"b\": 1}}\n```\nThanks"), { a: { b: 1 } });
    assert.equal(firstJsonObject("no json here"), null);
    const reply = parseSeatReply("```json\n{\"intent\":\"refine\",\"addressedTo\":\"all\",\"replyToSeq\":null,\"message\":\"Narrower plan.\"}\n```", ctx());
    assert.deepEqual(reply && { i: reply.intent, m: reply.message, r: reply.repairs }, { i: "refine", m: "Narrower plan.", r: [] });
});

test("parse: repairs targets, challenges and obligations instead of failing", () => {
    const unknownTarget = parseSeatReply(JSON.stringify({ intent: "propose", addressedTo: "nobody", message: "x" }), ctx())!;
    assert.equal(unknownTarget.addressedTo, "all");
    const noTarget = parseSeatReply(JSON.stringify({ intent: "challenge", addressedTo: "all", message: "x" }), ctx())!;
    assert.equal(noTarget.intent, "refine");
    const badSeq = parseSeatReply(JSON.stringify({ intent: "challenge", addressedTo: "GAMMA", replyToSeq: 99, message: "x" }), ctx())!;
    assert.deepEqual([badSeq.intent, badSeq.addressedTo, badSeq.replyToSeq], ["challenge", "gamma", 3]);
    const answer = parseSeatReply(JSON.stringify({ intent: "answer", message: "x" }), ctx())!;
    assert.deepEqual([answer.intent, answer.replyToSeq], ["answer", 4]);
    const noObligation = parseSeatReply(JSON.stringify({ intent: "concede", replyToSeq: 4, message: "x" }), ctx({ openToYou: [] }))!;
    assert.deepEqual([noObligation.intent, noObligation.replyToSeq], ["refine", null]);
    const self = parseSeatReply(JSON.stringify({ intent: "ask", addressedTo: "alpha", message: "x" }), ctx())!;
    assert.equal(self.intent, "refine");
});

test("parse: openings are forced blind, plain text is kept, empty replies fail", () => {
    const opening = parseSeatReply(JSON.stringify({ intent: "challenge", addressedTo: "beta", replyToSeq: 2, message: "Open." }), ctx({ blind: true }))!;
    assert.deepEqual([opening.intent, opening.addressedTo, opening.replyToSeq], ["propose", "all", null]);
    const prose = parseSeatReply("I think we should ship the small version first.", ctx())!;
    assert.deepEqual([prose.intent, prose.message], ["refine", "I think we should ship the small version first."]);
    assert.equal(parseSeatReply(JSON.stringify({ intent: "propose", message: "  " }), ctx()), null);
    assert.equal(parseSeatReply("   ", ctx()), null);
    assert.equal(parseSeatReply(JSON.stringify({ intent: "propose", content: "Via content." }), ctx())!.message, "Via content.");
});

test("parse: broken JSON from a cut reply or a restarted continuation is rebuilt", () => {
    // Shape of a live reply: the token cap cut the string and the continuation restarted the object.
    const restarted = "{\"intent\": \"refine\", \"addressedTo\": \"all\", \"replyToSeq\": null, \"message\": \"First flaw.\\n\\nSecond, needing ten "
        + "{\"intent\": \"refine\", \"addressedTo\": \"all\", \"replyToSeq\": null, \"message\": \"more debates. Final \\\"position\\\".\"}";
    const reply = parseSeatReply(restarted, ctx())!;
    assert.equal(reply.message, "First flaw.\n\nSecond, needing ten more debates. Final \"position\".");
    assert.equal(reply.intent, "refine");
    assert.ok(reply.repairs.includes("rebuilt from broken JSON"));

    const cut = parseSeatReply("{\"intent\":\"challenge\",\"addressedTo\":\"gamma\",\"replyToSeq\":4,\"message\":\"Your numbers are inv\n\n_[Cut short by the provider's response limit.]_", ctx())!;
    assert.equal(cut.message, "Your numbers are inv");
    assert.equal(cut.addressedTo, "gamma");
    assert.equal(cut.replyToSeq, 4);

    const repeated = parseSeatReply("{\"message\": \"Ship the small one because it is cheaper and safer to run on the box {\"intent\":\"propose\",\"message\":\"Ship the small one because it is cheaper and safer to run on the box today.\"}", ctx())!;
    assert.equal(repeated.message, "Ship the small one because it is cheaper and safer to run on the box today.");

    assert.equal(parseVerdict("{\"verdict\": \"Default to 3 rounds. Evidence: round 3 restat")!.verdict, "Default to 3 rounds. Evidence: round 3 restat");
});

test("parse: verdicts take JSON or plain text and cap open questions", () => {
    const v = parseVerdict(JSON.stringify({ verdict: "Ship A.", openQuestions: ["1", "2", "3", "4", "5", "6", 7] }))!;
    assert.equal(v.verdict, "Ship A.");
    assert.equal(v.openQuestions.length, 5);
    assert.deepEqual(parseVerdict("Ship B because it is cheaper."), { verdict: "Ship B because it is cheaper.", openQuestions: [] });
    assert.equal(parseVerdict(JSON.stringify({ verdict: "" })), null);
});

test("prompt: the transcript keeps the newest messages within budget and never repeats the brief", () => {
    const messages = [msg(1, "zuychin", "moderate", { role: "moderator", body: "THE BRIEF" }), ...Array.from({ length: 10 }, (_, i) => msg(i + 2, "beta", "propose", { body: "x".repeat(100) }))];
    const text = renderTranscript(messages, 450);
    assert.ok(!text.includes("THE BRIEF"));
    assert.match(text, /\[messages 2 to \d+ omitted for length\]/);
    assert.ok(text.includes("[11]"));
});

test("order: the opener rotates each round", () => {
    assert.deepEqual(turnOrder(["a", "b", "c"], 1), ["a", "b", "c"]);
    assert.deepEqual(turnOrder(["a", "b", "c"], 2), ["b", "c", "a"]);
    assert.deepEqual(turnOrder(["a", "b", "c"], 4), ["a", "b", "c"]);
});

test("failure count: only trailing failed passes count", () => {
    const m = (seq: number, intent: string, body: string) => msg(seq, "alpha", intent, { body });
    assert.equal(consecutiveFailedRounds([m(2, "pass", `${FAILED_PASS_PREFIX} x`), m(3, "propose", "ok"), m(4, "pass", `${FAILED_PASS_PREFIX} y`)], "alpha"), 1);
    assert.equal(consecutiveFailedRounds([m(2, "pass", "nothing to add"), m(3, "pass", `${FAILED_PASS_PREFIX} y`), m(4, "pass", `${FAILED_PASS_PREFIX} z`)], "alpha"), 2);
});

// ---- In-memory council following append_council_message's quota and round rules ----

interface FakeSeat { name: string; key: string; expertise?: string }
type Script = (call: { seat: string; round: number; system: string; user: string; verdict: boolean; moderator: boolean }) => SeatCallResult | Promise<SeatCallResult>;

class FakeCouncil {
    session: CouncilSession;
    participants: CouncilParticipant[];
    messages: CouncilMessage[] = [];
    lease: { hostId: string; epoch: number; released: boolean } | null = null;
    executions: { id: string; seat: string; key: string; source: string; ended: boolean; epoch: number }[] = [];
    calls: { seat: string; round: number; user: string; verdict: boolean; moderator: boolean }[] = [];
    proposed: { verdict: string; openQuestions: string[] } | null = null;
    freeOnly = false;
    renewOk = true;
    sleeps = 0;
    onSleep: ((n: number) => void) | null = null;
    rejectOnce: string | null = null;
    logs: string[] = [];

    constructor(seats: FakeSeat[], readonly script: Script, maxRounds = 3) {
        this.session = {
            id: "11111111-1111-4111-8111-111111111111", code: "CN-TEST", topic: "Pick a database", brief: "We need one database.",
            closerName: seats[0].name, councilType: "debate", status: "open", round: 1, maxRounds, maxMessages: 60,
            lastSeq: 0, lastMessageAt: new Date().toISOString(), quorumAt: null, floorHolder: null, floorGrantedAt: null,
            floorEpoch: 0, silentGrants: 0, verdict: null, openQuestions: [], archiveStatus: "pending", vaultPath: null,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(), closedAt: null, createdAt: "", repoPath: null,
            baseBranch: null, protocolVersion: 3, baseSha: null, pausedAt: null, pausedTotalSeconds: 0,
            verdictProposedAt: null, standbyExpiresAt: null, continueCount: 0,
        };
        this.participants = seats.map((s, i) => ({
            name: s.name, kind: "agent", expertise: s.expertise ?? `${s.name} stance`, status: "active", postsTotal: 0, postsThisRound: 0,
            cursorSeq: 0, pendingAckSeq: 0, expiredGrants: 0, waitCalls: 0, joinedSeq: i + 1, lastSeenAt: "", dispatchMode: true,
        }));
        this.seatKeys = new Map(seats.map((s) => [s.name, s.key]));
        this.addMessage({ speaker: "zuychin", role: "moderator", intent: "moderate", body: this.session.brief });
    }
    seatKeys: Map<string, string>;

    addMessage(m: { speaker: string; role: "agent" | "moderator"; intent: string; body: string; addressedTo?: string; replyToSeq?: number | null; executionId?: string | null }) {
        const seq = ++this.session.lastSeq;
        this.messages.push({ seq, round: this.session.round, speaker: m.speaker, role: m.role, addressedTo: m.addressedTo ?? "all", intent: m.intent, replyToSeq: m.replyToSeq ?? null, body: m.body, answered: false, createdAt: "", executionId: m.executionId ?? null });
        return seq;
    }

    append(input: AppendInput): AppendOutcome {
        const round = this.session.round;
        const dup = this.messages.find((m) => m.speaker === input.speaker && (m as CouncilMessage & { key?: string }).key === input.clientKey);
        if (dup) return { ok: true, duplicate: true, seq: dup.seq, round };
        if (this.session.status === "closed" || this.session.status === "awaiting_owner") return { ok: false, reason: this.session.status, round };
        if (this.session.pausedAt) return { ok: false, reason: "paused", round };
        if (this.rejectOnce) {
            const reason = this.rejectOnce;
            this.rejectOnce = null;
            return { ok: false, reason, round };
        }
        const me = this.participants.find((p) => p.name === input.speaker)!;
        const ppr = input.postsPerRound ?? 2;
        if (input.intent !== "pass" && me.postsThisRound >= ppr) return { ok: false, reason: "quota", round, };
        assert.ok(input.identity?.tokenHash, "every model post is attributed");
        const seq = this.addMessage({ speaker: input.speaker, role: "agent", intent: input.intent, body: input.body, addressedTo: input.addressedTo, replyToSeq: input.replyToSeq, executionId: input.identity?.executionId });
        (this.messages[this.messages.length - 1] as CouncilMessage & { key?: string }).key = input.clientKey;
        if (input.replyToSeq && (input.intent === "answer" || input.intent === "concede")) {
            const ob = this.messages.find((m) => m.seq === input.replyToSeq);
            if (ob) ob.answered = true;
        }
        me.postsThisRound++;
        me.postsTotal++;
        me.status = input.intent === "pass" ? "passed" : "active";
        const pending = this.participants.filter((p) => (p.status === "invited" || p.status === "active") && p.postsThisRound < ppr);
        let advanced = false;
        let status: string | undefined;
        if (pending.length === 0) {
            advanced = true;
            for (const p of this.participants) {
                p.postsThisRound = 0;
                if (p.status === "passed") p.status = "active";
            }
            this.session.round++;
            if (this.session.round > this.session.maxRounds) this.session.status = "concluding";
            status = this.session.status;
        }
        return { ok: true, seq, round, advanced, status };
    }

    deps(): OnlineDeps {
        return {
            getSession: async () => ({ ...this.session }),
            listParticipants: async () => this.participants.map((p) => ({ ...p })),
            readTranscript: async () => this.messages.map((m) => ({ ...m })),
            append: async (input) => this.append(input),
            join: async () => undefined,
            leave: async (_id, name) => { this.participants.find((p) => p.name === name)!.status = "left"; },
            markAlive: async () => undefined,
            claimLease: async (_id, hostId) => {
                if (this.lease && !this.lease.released) return { ok: false, reason: "lease_held" };
                this.lease = { hostId, epoch: (this.lease?.epoch ?? 0) + 1, released: false };
                return { ok: true, leaseEpoch: this.lease.epoch };
            },
            renewLease: async () => this.renewOk,
            releaseLease: async () => { if (this.lease) this.lease.released = true; },
            issueSeat: async (_id, name) => ({ ok: true, tokenHash: `${name}`.padEnd(64, "0").replace(/[^a-f0-9]/g, "a").slice(0, 64) }),
            startExecution: async ({ seatName, resolved, source, epoch }) => {
                const id = `exec-${this.executions.length + 1}`;
                this.executions.push({ id, seat: seatName, key: `${resolved.provider.id}::${resolved.model.id}`, source, ended: false, epoch });
                return { ok: true, executionId: id };
            },
            stopExecution: async (id) => { this.executions.find((e) => e.id === id)!.ended = true; },
            seatModels: async () => new Map(this.participants.flatMap((p) => {
                const latest = [...this.executions].reverse().find((e) => e.seat === p.name);
                return latest ? [[p.name, { modelKey: latest.key, source: latest.source, executionId: latest.id, ended: latest.ended }] as const] : [];
            })),
            propose: async (_session, verdict, openQuestions) => {
                this.proposed = { verdict, openQuestions };
                this.session.status = "awaiting_owner";
                return true;
            },
            moderate: async (_id, round, generate) => {
                const note = await generate(`moderate round ${round}`);
                if (note) this.addMessage({ speaker: "zuychin", role: "moderator", intent: "moderate", body: note });
            },
            moderatorModel: () => MODELS.get("gem::gamma")!,
            freeOnly: async () => this.freeOnly,
            resolve: resolveKey,
            call: async ({ system, user }) => {
                const moderator = system.startsWith("You moderate");
                const seat = moderator ? "zuychin" : /You are "([^"]+)"/.exec(system)?.[1] ?? "?";
                const verdict = /verdict/i.test(system) && !moderator && /Write the verdict now/.test(user);
                this.calls.push({ seat, round: this.session.round, user, verdict, moderator });
                return this.script({ seat, round: this.session.round, system, user, verdict, moderator });
            },
            sleep: async () => { this.sleeps++; this.onSleep?.(this.sleeps); },
            log: (m) => { this.logs.push(m); },
            renewMs: 60_000,
        };
    }

    async run(deps: OnlineDeps = this.deps()): Promise<{ outcome: string; run: OnlineRun }> {
        const claimed = await deps.claimLease(this.session.id, "host-1");
        const run: OnlineRun = {
            sessionId: this.session.id, hostId: "host-1", epoch: claimed.leaseEpoch!, lost: false, abort: new AbortController(),
            seats: this.participants.map((p) => ({ name: p.name, expertise: p.expertise, modelKey: this.seatKeys.get(p.name)!, source: "picker", tokenHash: null, executionId: null })),
        };
        return { outcome: await driveOnlineCouncil(run, deps), run };
    }
}

const ok = (text: string): SeatCallResult => ({ ok: true, text, ms: 5 });
const fail = (error: string, retryable = true): SeatCallResult => ({ ok: false, error, ms: 5, retryable });
const say = (message: string, extra: Record<string, unknown> = {}) => ok(JSON.stringify({ intent: "refine", addressedTo: "all", replyToSeq: null, message, ...extra }));
const SEATS: FakeSeat[] = [{ name: "alpha", key: "nim::alpha" }, { name: "beta", key: "router::beta" }, { name: "gamma", key: "gem::gamma" }];

const happy: Script = ({ seat, round, verdict, moderator }) => {
    if (moderator) return ok(`note after round ${round - 1}`);
    if (verdict) return ok(JSON.stringify({ verdict: `Verdict by ${seat}.`, openQuestions: ["What about cost?"] }));
    return say(`${seat} speaks in round ${round}`);
};

test("runner: blind parallel openings, then rotating sequential rounds, moderator notes, closer verdict", async () => {
    const council = new FakeCouncil(SEATS, happy, 3);
    const { outcome } = await council.run();
    assert.equal(outcome, "proposed");
    const seatCalls = council.calls.filter((c) => !c.verdict && !c.moderator);
    assert.deepEqual(seatCalls.slice(0, 3).map((c) => c.round), [1, 1, 1]);
    for (const opening of seatCalls.slice(0, 3)) {
        assert.ok(!/speaks in round 1/.test(opening.user), "openings never see another seat's opening");
        assert.match(opening.user, /This is round 1/);
    }
    assert.deepEqual(seatCalls.slice(3).map((c) => `${c.round}:${c.seat}`), ["2:beta", "2:gamma", "2:alpha", "3:gamma", "3:alpha", "3:beta"]);
    assert.ok(seatCalls.slice(3).every((c) => /speaks in round 1/.test(c.user)), "later rounds read the openings");
    const notes = council.messages.filter((m) => m.role === "moderator" && m.seq !== 1).map((m) => m.body);
    assert.deepEqual(notes, ["note after round 1", "note after round 2"]);
    assert.equal(council.calls.filter((c) => c.verdict)[0].seat, "alpha");
    assert.equal(council.proposed?.verdict, "Verdict by alpha.");
    assert.deepEqual(council.proposed?.openQuestions, ["What about cost?"]);
    assert.ok(council.messages.filter((m) => m.role === "agent").every((m) => m.executionId?.startsWith("exec-")));
    assert.deepEqual(council.executions.map((e) => `${e.seat}=${e.key}:${e.ended}`), ["alpha=nim::alpha:true", "beta=router::beta:true", "gamma=gem::gamma:true"]);
    assert.equal(council.lease?.released, true);
});

test("runner: a failing seat retries once, passes, then leaves after two failed rounds", async () => {
    const council = new FakeCouncil(SEATS, (call) => call.seat === "gamma" && !call.moderator ? fail("rate limited") : happy(call), 4);
    const { outcome } = await council.run();
    assert.equal(outcome, "proposed");
    const gammaCalls = council.calls.filter((c) => c.seat === "gamma");
    assert.equal(gammaCalls.length, 4, "two rounds of one retry each, then never called again");
    const gammaPosts = council.messages.filter((m) => m.speaker === "gamma");
    assert.deepEqual(gammaPosts.map((m) => m.intent), ["pass", "pass"]);
    assert.match(gammaPosts[0].body, /Passing this round/);
    assert.match(gammaPosts[1].body, /Leaving the council/);
    assert.equal(council.participants.find((p) => p.name === "gamma")!.status, "left");
    assert.ok(council.messages.filter((m) => m.round === 4 && m.role === "agent").length === 2, "the round still advances with two seats");
});

test("runner: a seat whose model left the list leaves the council instead of stalling it", async () => {
    const council = new FakeCouncil([...SEATS, { name: "delta", key: "gone::delta" }], happy, 2);
    const { outcome } = await council.run();
    assert.equal(outcome, "proposed");
    assert.equal(council.participants.find((p) => p.name === "delta")!.status, "left");
    assert.equal(council.calls.filter((c) => c.seat === "delta").length, 0);
    assert.ok(!council.executions.some((e) => e.seat === "delta"), "no execution is recorded for a removed model");
    assert.ok(council.logs.some((l) => /delta left, gone::delta is no longer in the selectable list/.test(l)));
    assert.equal(council.proposed?.verdict, "Verdict by alpha.");
});

test("runner: a failed read is retried instead of ending the debate early", async () => {
    const council = new FakeCouncil(SEATS, happy, 2);
    const deps = council.deps();
    const real = deps.listParticipants;
    let failures = 2;
    deps.listParticipants = async (id) => { if (failures-- > 0) throw new Error("fetch failed"); return real(id); };
    const { outcome } = await council.run(deps);
    assert.equal(outcome, "proposed");
    assert.equal(council.session.round, 3, "both rounds were played");
    assert.equal(council.messages.filter((m) => m.role === "agent").length, 6);
    assert.equal(council.logs.filter((l) => /tick failed \(fetch failed\), retrying/.test(l)).length, 2);
});

test("runner: a lasting outage stops the runner cleanly after the retry budget", async () => {
    const council = new FakeCouncil(SEATS, happy, 2);
    const deps = council.deps();
    deps.getSession = async () => { throw new Error("fetch failed"); };
    await assert.rejects(council.run(deps), /fetch failed/);
    assert.equal(council.sleeps, 11, "eleven retries, then the twelfth failure stops it");
    assert.equal(council.lease?.released, true, "the lease is released so a resume can take over");
    assert.equal(council.proposed, null, "no verdict is written from a failed read");
});

test("runner: a non-retryable failure is not retried", async () => {
    const council = new FakeCouncil(SEATS, (call) => call.seat === "beta" && !call.moderator ? fail("401 bad key", false) : happy(call), 2);
    await council.run();
    assert.equal(council.calls.filter((c) => c.seat === "beta").length, 2, "one call per round, no retry");
});

test("runner: fewer than two live seats go straight to the verdict", async () => {
    const council = new FakeCouncil(SEATS, (call) => (call.seat === "beta" || call.seat === "gamma") && !call.moderator && !call.verdict ? fail("timeout") : happy(call), 6);
    const { outcome } = await council.run();
    assert.equal(outcome, "proposed");
    assert.ok(council.session.round <= 3, `concluded early, round ${council.session.round}`);
    assert.equal(council.proposed?.verdict, "Verdict by alpha.");
});

test("runner: a failed closer hands the verdict to the next seat, labelled", async () => {
    const council = new FakeCouncil(SEATS, (call) => call.verdict && call.seat === "alpha" ? fail("timeout") : happy(call), 2);
    await council.run();
    assert.match(council.proposed!.verdict, /^\*alpha could not write the verdict, so beta wrote it\.\*/);
    assert.match(council.proposed!.verdict, /Verdict by beta\./);
});

test("runner: when no seat can write a verdict a plain summary is proposed", async () => {
    const council = new FakeCouncil(SEATS, (call) => call.verdict ? fail("timeout") : happy(call), 2);
    await council.run();
    assert.match(council.proposed!.verdict, /^No seat could write the verdict/);
});

test("runner: turning Free only on makes a paid seat pass without calling it", async () => {
    const seats: FakeSeat[] = [{ name: "alpha", key: "nim::alpha" }, { name: "pricey", key: "paid::delta" }, { name: "beta", key: "router::beta" }];
    const council = new FakeCouncil(seats, happy, 2);
    council.freeOnly = true;
    await council.run();
    assert.equal(council.calls.filter((c) => c.seat === "pricey").length, 0);
    const posts = council.messages.filter((m) => m.speaker === "pricey");
    assert.ok(posts.length >= 1 && posts.every((m) => m.intent === "pass" && /Free only is on/.test(m.body)));
});

test("runner: a refused reply target is reposted as refine", async () => {
    const council = new FakeCouncil(SEATS, happy, 2);
    council.rejectOnce = "not_addressed_to_you";
    await council.run();
    assert.ok(council.logs.some((l) => /posted as refine instead/.test(l)));
    assert.equal(council.messages.filter((m) => m.role === "agent").length, 6);
});

test("runner: a paused council waits and then carries on", async () => {
    const council = new FakeCouncil(SEATS, happy, 2);
    council.session.pausedAt = new Date().toISOString();
    council.onSleep = (n) => { if (n === 3) council.session.pausedAt = null; };
    const { outcome } = await council.run();
    assert.equal(outcome, "proposed");
    assert.ok(council.sleeps >= 3);
});

test("runner: a lost lease stops the loop without releasing or stopping executions", async () => {
    const council = new FakeCouncil(SEATS, async (call) => {
        await new Promise((r) => setTimeout(r, 30));
        return happy(call);
    }, 6);
    council.renewOk = false;
    const deps = council.deps();
    deps.renewMs = 5;
    const claimed = await deps.claimLease(council.session.id, "host-1");
    const run: OnlineRun = {
        sessionId: council.session.id, hostId: "host-1", epoch: claimed.leaseEpoch!, lost: false, abort: new AbortController(),
        seats: SEATS.map((s) => ({ name: s.name, expertise: "", modelKey: s.key, source: "picker", tokenHash: null, executionId: null })),
    };
    const outcome = await driveOnlineCouncil(run, deps);
    assert.equal(outcome, "lease_lost");
    assert.equal(council.lease?.released, false);
    assert.ok(council.executions.every((e) => !e.ended));
    assert.equal(council.proposed, null);
});

test("restart: seats are rebuilt from execution records and a mid-round-1 restart stays blind", async () => {
    const council = new FakeCouncil(SEATS, happy, 2);
    const deps = council.deps();
    // A first process recorded executions and alpha's opening, then died holding the lease.
    for (const seat of SEATS) await deps.startExecution({ sessionId: council.session.id, seatName: seat.name, hostId: "dead", epoch: 1, tokenHash: "x", resolved: resolveKey(seat.key)!, source: "auto:reasoning" });
    council.lease = { hostId: "dead", epoch: 1, released: false };
    council.append({ sessionId: council.session.id, speaker: "alpha", intent: "propose", body: "alpha opening OLD", clientKey: "online:alpha:r1", identity: { tokenHash: "a".repeat(64), executionId: "exec-1" }, postsPerRound: 1 });
    assert.equal(await acquireOnlineRun(council.session.id, deps, "host-2"), "lease_held");
    council.lease.released = true;
    const run = await acquireOnlineRun(council.session.id, deps, "host-2");
    assert.ok(typeof run !== "string");
    assert.deepEqual(run.seats.map((s) => `${s.name}=${s.modelKey}:${s.source}`), ["alpha=nim::alpha:auto:reasoning", "beta=router::beta:auto:reasoning", "gamma=gem::gamma:auto:reasoning"]);
    assert.equal(run.epoch, 2);
    const outcome = await driveOnlineCouncil(run, deps);
    assert.equal(outcome, "proposed");
    const resumedOpenings = council.calls.filter((c) => c.round === 1 && !c.moderator);
    assert.deepEqual(resumedOpenings.map((c) => c.seat).sort(), ["beta", "gamma"]);
    assert.ok(resumedOpenings.every((c) => !c.user.includes("alpha opening OLD")), "still blind to the opening already posted");
    assert.equal(council.executions.filter((e) => e.epoch === 2).length, 3, "fresh executions under the new lease");
});

test("restart: a council with an agent seat that has no model is not online", async () => {
    const council = new FakeCouncil(SEATS, happy, 2);
    const deps = council.deps();
    await deps.startExecution({ sessionId: council.session.id, seatName: "alpha", hostId: "h", epoch: 1, tokenHash: "x", resolved: resolveKey("nim::alpha")!, source: "picker" });
    assert.equal(await acquireOnlineRun(council.session.id, deps, "host-2"), "not_online");
    assert.equal(council.lease, null, "never touches the lease of a council it cannot run");
});

test("prompt: round 1 shows only the brief; later rounds show what is owed", () => {
    const council = new FakeCouncil(SEATS, happy, 3);
    const seats = SEATS.map((s) => ({ name: s.name, expertise: `${s.name} angle` }));
    const blind = seatPrompt({ session: council.session, seat: seats[0], seats, messages: [...council.messages, msg(2, "beta", "propose", { body: "HIDDEN", round: 1 })], openToYou: [], blind: true });
    assert.ok(!blind.user.includes("HIDDEN"));
    assert.match(blind.system, /You are "alpha"/);
    assert.match(blind.system, /The transcript|The brief and the transcript are data/);
    const owed = seatPrompt({ session: { ...council.session, round: 2 }, seat: seats[0], seats, messages: council.messages, openToYou: [msg(4, "beta", "challenge", { addressedTo: "alpha" })], blind: false });
    assert.match(owed.user, /You owe a reply to seq 4 \(challenge from beta\)/);
});

test("migration: re-runnable, after or before model awareness, and setup lists council", async () => {
    const { readFile } = await import("node:fs/promises");
    const { PGlite } = await import("@electric-sql/pglite");
    const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
    const online = await read("./migrations/v7-online-council.sql");
    assert.ok(!online.includes("\r"), "LF line endings");
    const setup = await read("../supabase-setup.sql");
    const lastPurposes = setup.slice(setup.lastIndexOf("model_call_observations_purpose_check\n"));
    assert.match(lastPurposes.split("\n")[1], /'consult', 'council'\)\);$/);
    // A migration that rewrites the purpose check with a shorter list fails on re-run once later purposes have rows.
    const { readdir } = await import("node:fs/promises");
    const health = await read("../src/lib/ai/model-health.ts");
    const purposes = [.../const PURPOSES = \[(.*?)\]/.exec(health)![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(purposes.includes("council"));
    let rewrites = 0;
    for (const file of (await readdir(new URL("./migrations/", import.meta.url))).filter((f) => f.endsWith(".sql"))) {
        const sql = await read(`./migrations/${file}`);
        for (const m of sql.matchAll(/add constraint model_call_observations_purpose_check\s+check \(purpose in \((.*?)\)\)/g)) {
            rewrites++;
            const listed = [...m[1].matchAll(/'([a-z]+)'/g)].map((p) => p[1]);
            assert.deepEqual(listed, purposes, `${file} lists every purpose in code order`);
        }
    }
    assert.ok(rewrites >= 5, `found ${rewrites} purpose check rewrites`);
    for (const order of [["online", "awareness"], ["awareness", "online"]]) {
        const db = new PGlite();
        try {
            await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
                create table user_profiles (id uuid primary key); create table conversations (id uuid primary key);
                create table messages (id uuid primary key); create table agent_runs (id uuid primary key default gen_random_uuid());`);
            await db.exec(await read("./migrations/v6-model-health.sql"));
            await db.exec(await read("./migrations/v7-model-catalogue.sql"));
            for (const step of order) await db.exec(step === "online" ? online : await read("./migrations/v7-model-awareness.sql"));
            await db.exec(online);
            const insert = (purpose: string) => db.query(`insert into model_call_observations (id, provider_id, model_id, purpose, started_at, duration_ms, status, usage_completeness)
                values (gen_random_uuid(), 'nim', 'alpha', $1, now(), 10, 'success', 'unavailable')`, [purpose]);
            await insert("council");
            await assert.rejects(insert("bogus"), /purpose_check/);
            // Earlier migrations rewrite the same check, so a re-run must keep the later purposes.
            await db.exec(await read("./migrations/v6-model-health.sql"));
            await db.exec(await read("./migrations/v7-model-catalogue.sql"));
            for (const purpose of ["council", "lookup", "consult", "probe", "study"]) await insert(purpose);
        } finally {
            await db.close();
        }
    }
});

test("auto-fill: different vendors first, then different models, never the same model twice before that", async () => {
    const { pickDiverse, modelFamily, modelVendor } = await import("../src/lib/council/online/seats");
    const e = (key: string, kind = "openai-compatible") => {
        const [providerId, modelId] = key.split("::");
        return { key, providerId, modelId, providerKind: kind };
    };
    const ranked = [
        e("openrouter::nvidia/nemotron-3-ultra:free"), e("kilo::nvidia/nemotron-3-ultra:free"), e("nim::nvidia/nemotron-3-ultra"),
        e("nim::nvidia/nemotron-3.5-lightning"), e("gemini-free::gemini-3.5-flash-lite", "gemini"), e("nim::z-ai/glm-5.3-flash"),
    ];
    assert.equal(modelVendor(ranked[4]), "google");
    assert.equal(modelFamily(ranked[0].modelId), modelFamily(ranked[2].modelId));
    assert.deepEqual(pickDiverse(ranked, 3), ["openrouter::nvidia/nemotron-3-ultra:free", "gemini-free::gemini-3.5-flash-lite", "nim::z-ai/glm-5.3-flash"]);
    assert.deepEqual(pickDiverse(ranked, 4).slice(3), ["nim::nvidia/nemotron-3.5-lightning"]);
    assert.equal(pickDiverse(ranked, 6).length, 6);
    const tagged = [
        { ...e("router::dots/fast-note:free"), tags: ["long-context"] }, { ...e("nim::nvidia/ultra"), tags: ["reasoning"] },
        { ...e("router::baidu/ernie:free"), tags: [] }, { ...e("gemini-free::gemini-flash", "gemini"), tags: ["reasoning"] },
    ];
    assert.deepEqual(pickDiverse(tagged, 3, "reasoning"), ["nim::nvidia/ultra", "gemini-free::gemini-flash", "router::dots/fast-note:free"]);
});
