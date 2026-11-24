import { OWNER_SCOPES } from "@/lib/agents/scopes";
import { getDefaultProfile, hybridSearchKnowledge, searchEmbeddings } from "@/lib/db";
import { embedText, getEmbeddingRef } from "@/lib/ai/embeddings";
import { similarityCutoffs } from "@/lib/ai/embedding-cutoffs";
import { refreshEmbeddingOverride } from "@/lib/ai/embedding-override";
import { collectModelObservations, configureModelDataPolicy } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { assertFreeModel } from "@/lib/ai/model-policy";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { tavilyConfigured, webSearchResults } from "@/lib/ai/web-search";
import type { ModelDataClass } from "@/lib/ai/data-policy";
import { availableChatModels, resolveChat, resolveMessagingDefault, resolveModelKey } from "@/lib/ai/providers";
import { catalogueSnapshot, refreshCatalogueSnapshot } from "@/lib/ai/catalogue/snapshot";
import { currentRoster, listForRun } from "@/lib/ai/models/roster";
import type { PurposeTag } from "@/lib/ai/models/tags";
import { proposeCouncilVerdict } from "@/lib/council/close";
import { startAgentExecution, stopAgentExecution, claimHostLease, renewHostLease, releaseHostLease } from "@/lib/council/host-service";
import { moderateRound } from "@/lib/council/moderator";
import { conveneCouncil, type ConveneRejection } from "@/lib/council/operations";
import { MAX_BODY_CHARS, MODERATOR_NAME, sleep } from "@/lib/council/protocol";
import { hashSeatToken, issueHostSeatKey } from "@/lib/council/seat-keys";
import {
    appendMessage, getSessionById, joinCouncil, leaveCouncil, listOpenCouncils, listParticipants,
    markParticipantsAlive, readTranscript,
} from "@/lib/council/store";
import { COUNCIL_HOST_GENERATION, configuredCapabilities } from "@/lib/council/v3";
import { getVaultConfig } from "@/lib/vault/github";
import { searchVaultPages, vaultEmbeddingRef } from "@/lib/vault/store";
import { rerank, resolveReranker } from "@/lib/ai/rerank";
import { callSeatModel } from "./call";
import {
    ADAPTER_VERSION, LEASE_SECONDS, ONLINE_DEFAULT_ROUNDS, ONLINE_MAX_ROUNDS, ONLINE_MIN_ROUNDS,
    ONLINE_TTL_MINUTES, RESEARCH_NOTES, RESEARCH_RERANK_TIMEOUT_MS, RESEARCH_VAULT_PAGES, RESEARCH_WEB_CANDIDATES,
    RESUME_FIRST_SCAN_MS, RESUME_SCAN_MS,
} from "./limits";
import { gatherResearch, savedNotesOnly, type ResearchDeps, type ResearchPack, type ResearchRequest, type ResearchSummary } from "./research";
import { acquireOnlineRun, driveOnlineCouncil, postResearchPack, prepareSeats, processHostId, type OnlineDeps, type OnlineRun, type RunOutcome } from "./runner";
import { isPaidModel, pickDiverse, resolveSeats, type OnlineSeatInput } from "./seats";
import { isOnlineCouncil, latestSeatModels, readLease } from "./store";

const HOST_CALLER = { scopes: ["council:host"] } as const;
const MAX_TOPIC_CHARS = 300;

function log(message: string): void {
    console.log(`[OnlineCouncil] ${message}`);
}

export function onlineDeps(): OnlineDeps {
    return {
        // Strict reads: an empty list on a network error would end the debate early.
        getSession: (sessionId) => getSessionById(sessionId, { strict: true }),
        listParticipants: (sessionId) => listParticipants(sessionId, { strict: true }),
        readTranscript: (sessionId) => readTranscript({ sessionId, limit: 200, strict: true }),
        append: (input) => appendMessage(input),
        postModerator: (sessionId, body, clientKey) => appendMessage({ sessionId, speaker: MODERATOR_NAME, role: "moderator", intent: "moderate", body, clientKey }),
        join: async (sessionId, name) => { await joinCouncil({ sessionId, agentName: name, dispatchMode: true }); },
        leave: leaveCouncil,
        markAlive: markParticipantsAlive,
        claimLease: (sessionId, hostId) => claimHostLease({ sessionId, hostId, durationSeconds: LEASE_SECONDS }, HOST_CALLER),
        renewLease: async (sessionId, hostId, epoch) => (await renewHostLease({ sessionId, hostId, leaseEpoch: epoch, durationSeconds: LEASE_SECONDS }, HOST_CALLER)).ok,
        releaseLease: async (sessionId, hostId, epoch) => { await releaseHostLease({ sessionId, hostId, leaseEpoch: epoch }, HOST_CALLER); },
        issueSeat: async (sessionId, seatName, hostId, epoch) => {
            const issued = await issueHostSeatKey({ sessionId, seatName, hostId, leaseEpoch: epoch, bindExecution: true }, HOST_CALLER);
            return issued.ok ? { ok: true, tokenHash: hashSeatToken(issued.token) } : issued;
        },
        startExecution: ({ sessionId, seatName, hostId, epoch, tokenHash, resolved, source }) => startAgentExecution({
            sessionId, agentName: seatName, seatTokenHash: tokenHash, hostId, leaseEpoch: epoch,
            hostGeneration: COUNCIL_HOST_GENERATION,
            capabilities: configuredCapabilities({ kind: "managed_api", modelSelection: true }),
            identityAssurance: "host_bound", provider: resolved.provider.id, adapterVersion: ADAPTER_VERSION,
            requestedModel: resolved.model.id, effectiveModel: resolved.model.id, modelSource: source,
        }, HOST_CALLER),
        stopExecution: async (executionId, hostId, epoch, reason) => { await stopAgentExecution({ executionId, hostId, leaseEpoch: epoch, stopReason: reason }, HOST_CALLER); },
        seatModels: latestSeatModels,
        propose: async (session, verdict, openQuestions) => (await proposeCouncilVerdict({ session, closer: session.closerName, verdict, openQuestions })).changed,
        moderate: (sessionId, round, generate) => moderateRound({ sessionId, round, generate }),
        moderatorModel: (freeOnly) => {
            try {
                if (!freeOnly) return resolveChat();
                const route = resolveMessagingDefault();
                return isPaidModel(route) ? null : route;
            } catch {
                return null;
            }
        },
        freeOnly: async () => effectiveFreeOnly(await getDefaultProfile()),
        resolve: resolveModelKey,
        call: callSeatModel,
        sleep,
        log,
    };
}

function registry(): Map<string, Promise<RunOutcome>> {
    const g = globalThis as { __zuychinOnlineRuns?: Map<string, Promise<RunOutcome>> };
    g.__zuychinOnlineRuns ??= new Map();
    return g.__zuychinOnlineRuns;
}

export function onlineRunnerActive(sessionId: string): boolean {
    return registry().has(sessionId);
}

/** Starts the loop in this process unless one is already running here. The host lease stops a second process. */
export function ensureOnlineRunner(sessionId: string, prepared?: OnlineRun, deps: OnlineDeps = onlineDeps()): boolean {
    const runs = registry();
    if (runs.has(sessionId)) return false;
    const task = (async (): Promise<RunOutcome> => {
        const run = prepared ?? await acquireOnlineRun(sessionId, deps);
        if (typeof run === "string") return run;
        return driveOnlineCouncil(run, deps);
    })().then((outcome) => {
        log(`${sessionId}: stopped (${outcome})`);
        return outcome;
    }, (error: unknown): RunOutcome => {
        console.error(`[OnlineCouncil] ${sessionId}: runner failed:`, error);
        return "gone";
    }).finally(() => runs.delete(sessionId));
    runs.set(sessionId, task);
    return true;
}

export interface StartOnlineInput {
    topic: string;
    brief: string;
    seats: OnlineSeatInput[];
    closerName?: string;
    /** Position of the closer in seats; the page sends this because default names are made here. */
    closerIndex?: number;
    maxRounds?: number;
    allowPaid?: boolean;
    research?: ResearchRequest;
}

export type StartOnlineResult =
    | {
        ok: true; code: string; seats: { name: string; modelKey: string; label: string; paid: boolean }[]; closerName: string; maxRounds: number;
        research?: ResearchSummary;
    }
    | { ok: false; status: 400 | 409 | 500; error: string };

function conveneError(rejection: ConveneRejection): string {
    switch (rejection.reason) {
        case "participant_count": return `A council takes 2 to 5 seats; got ${rejection.count}.`;
        case "closer_not_participant": return `The closer must be one of ${rejection.names.join(", ")}.`;
        case "duplicate_names": return `Seat names must be unique; got ${rejection.names.join(", ")}.`;
        case "reserved_name": return `"${rejection.name}" is reserved for the moderator.`;
        case "council_type": return `Councils are debates; "${rejection.councilType}" councils are not supported.`;
        case "open_limit": return `${rejection.open.length} councils are already open (${rejection.open.map((s) => s.code).join(", ")}). Close one first.`;
    }
}

export function clampRounds(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : ONLINE_DEFAULT_ROUNDS;
    return Math.min(ONLINE_MAX_ROUNDS, Math.max(ONLINE_MIN_ROUNDS, n));
}

/** Convenes, takes the lease and records every seat's model before returning, so a council never runs without its seat records. */
export async function startOnlineCouncil(input: StartOnlineInput, deps: OnlineDeps = onlineDeps()): Promise<StartOnlineResult> {
    const topic = typeof input.topic === "string" ? input.topic.trim() : "";
    const brief = typeof input.brief === "string" ? input.brief.trim() : "";
    if (!topic) return { ok: false, status: 400, error: "A council needs a topic." };
    if (!brief) return { ok: false, status: 400, error: "A council needs a brief." };
    if (topic.length > MAX_TOPIC_CHARS) return { ok: false, status: 400, error: `Keep the topic under ${MAX_TOPIC_CHARS} characters.` };
    if (brief.length > MAX_BODY_CHARS) return { ok: false, status: 400, error: `Keep the brief under ${MAX_BODY_CHARS} characters.` };
    if (!Array.isArray(input.seats)) return { ok: false, status: 400, error: "Send 2 to 5 seats." };

    const freeOnly = await deps.freeOnly();
    const resolved = resolveSeats(input.seats, { freeOnly, allowPaid: input.allowPaid === true }, deps.resolve);
    if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
    const seats = resolved.seats;
    const wanted = (input.closerName ?? "").trim().toLowerCase();
    const byIndex = Number.isInteger(input.closerIndex) ? seats[input.closerIndex!] : undefined;
    const closer = byIndex ?? (wanted ? seats.find((s) => s.name.toLowerCase() === wanted) : seats[0]);
    if (!closer) return { ok: false, status: 400, error: `The closer must be one of ${seats.map((s) => s.name).join(", ")}.` };
    const maxRounds = clampRounds(input.maxRounds);
    // Before convening, so a slow search never holds a council that has no seats yet.
    const pack = input.research ? await runResearch(topic, input.research, freeOnly) : null;

    const convened = await conveneCouncil({
        topic, brief, closerName: closer.name, councilType: "debate",
        participants: seats.map((s) => ({ name: s.name, expertise: s.expertise })),
        maxRounds,
        // Every agent post, pass and moderator note counts here; rounds end the debate first.
        maxMessages: seats.length * maxRounds + maxRounds + 20,
        ttlMinutes: ONLINE_TTL_MINUTES,
    }, { scopes: OWNER_SCOPES });
    if (convened.kind === "denied") return { ok: false, status: 500, error: convened.message };
    if (convened.kind === "rejected") return { ok: false, status: convened.rejection.reason === "open_limit" ? 409 : 400, error: conveneError(convened.rejection) };
    const session = convened.session;

    const hostId = processHostId();
    const lease = await deps.claimLease(session.id, hostId);
    if (!lease.ok || !lease.leaseEpoch) {
        return { ok: false, status: 500, error: `Council ${session.code} was created but its host lease was refused (${lease.reason ?? "unknown"}). The sweep files it.` };
    }
    for (const seat of seats) await deps.join(session.id, seat.name);
    const researchWarning = pack ? await postResearchPack(session.id, pack, deps) : null;
    const run: OnlineRun = {
        sessionId: session.id, hostId, epoch: lease.leaseEpoch, lost: false, abort: new AbortController(),
        seats: seats.map((s) => ({ name: s.name, expertise: s.expertise, modelKey: s.modelKey, source: s.source, tokenHash: null, executionId: null })),
    };
    const setup = await prepareSeats(run, deps);
    if (setup) {
        await deps.releaseLease(session.id, hostId, lease.leaseEpoch).catch(() => undefined);
        return { ok: false, status: 500, error: `Council ${session.code} was created but a seat could not be set up (${setup}). The sweep files it.` };
    }
    ensureOnlineRunner(session.id, run, deps);
    return {
        ok: true, code: session.code, closerName: closer.name, maxRounds,
        seats: seats.map((s) => ({ name: s.name, modelKey: s.modelKey, label: s.resolved.model.label, paid: s.paid })),
        ...(pack ? { research: summarise(pack, researchWarning) } : {}),
    };
}

function summarise(pack: ResearchPack, warning: string | null): ResearchSummary {
    const posted = warning ? [] : pack.sources;
    return {
        web: posted.filter((s) => s.kind === "web").length,
        notes: posted.filter((s) => s.kind === "note").length,
        vault: posted.filter((s) => s.kind === "vault").length,
        problems: warning ? [...pack.problems, warning] : pack.problems,
    };
}

function researchDeps(freeOnly: boolean): ResearchDeps {
    return {
        // Tavily alone: runWebSearch falls back to paid Gemini grounding, which Free only refuses.
        searchWeb: async (query) => {
            if (!tavilyConfigured()) return "unconfigured";
            const route = await resolveReranker(freeOnly);
            const results = (await webSearchResults(query, "quick", undefined, route ? RESEARCH_WEB_CANDIDATES : undefined))?.results;
            if (!results || !route) return results ?? null;
            const order = await rerank(query, results, { freeOnly, route, timeoutMs: RESEARCH_RERANK_TIMEOUT_MS, text: (hit) => `${hit.title}\n${hit.content}` });
            return order.ok ? order.items : results;
        },
        searchNotes: async (query) => {
            await refreshEmbeddingOverride(undefined, freeOnly);
            const embRef = getEmbeddingRef();
            if (freeOnly) assertFreeModel(embRef);
            const embedding = await embedText(embRef, query, "query");
            // Wide, because chat messages and documents share the index and are filtered out.
            const matchCount = RESEARCH_NOTES * 3;
            const rows = await hybridSearchKnowledge({ queryEmbedding: embedding, queryText: query, matchCount, embeddingModel: embRef.model.id })
                ?? await searchEmbeddings({ queryEmbedding: embedding, matchThreshold: similarityCutoffs(embRef.model).toolNotes, matchCount, embeddingModel: embRef.model.id });
            return savedNotesOnly(rows);
        },
        searchVault: async (query) => {
            if (!getVaultConfig()) return null;
            const hits = await searchVaultPages({ query, embRef: await vaultEmbeddingRef(), hybrid: true, onePerPage: true, matchCount: RESEARCH_VAULT_PAGES,
                rerank: { freeOnly, timeoutMs: RESEARCH_RERANK_TIMEOUT_MS } });
            return hits.map((hit) => ({ path: hit.path, title: hit.title, summary: hit.summary }));
        },
    };
}

/** The embedding calls behind the notes search are recorded in model health like any seat call. */
async function runResearch(topic: string, request: ResearchRequest, freeOnly: boolean): Promise<ResearchPack> {
    const classes: ModelDataClass[] = ["personal", ...(request.notes ? ["knowledge" as const] : []), ...(request.web ? ["public_search" as const] : [])];
    const collected = await collectModelObservations(async () => {
        configureModelDataPolicy(freeOnly);
        return gatherResearch({ topic, request, freeOnly }, researchDeps(freeOnly));
    }, classes);
    if (collected.observations.length) await persistModelObservations(collected.observations).catch(() => null);
    const pack = collected.value;
    log(`research for "${pack.query.slice(0, 80)}": ${pack.sources.length} source(s)${pack.problems.length ? `; ${pack.problems.join(" ")}` : ""}`);
    return pack;
}

function resumeEnabled(): boolean {
    const flag = process.env.COUNCIL_ONLINE_RESUME?.trim().toLowerCase();
    if (flag === "off") return false;
    if (flag === "on") return true;
    return process.env.NODE_ENV === "production";
}

/** Picks up open online councils whose lease lapsed, such as after a restart. Agent councils are never touched. */
export async function resumeOnlineCouncils(): Promise<number> {
    if (!resumeEnabled()) return 0;
    // Until the catalogue loads, catalogue seats look removed and would be sent out of the room.
    const catalogue = catalogueSnapshot().loadedAt ? catalogueSnapshot() : await refreshCatalogueSnapshot();
    if (catalogue.storage === "unavailable") return 0;
    let started = 0;
    for (const session of await listOpenCouncils()) {
        if (onlineRunnerActive(session.id) || session.protocolVersion !== 3 || session.councilType !== "debate") continue;
        if ((await readLease(session.id))?.live) continue;
        if (!(await isOnlineCouncil(session.id).catch(() => false))) continue;
        if (ensureOnlineRunner(session.id)) started++;
    }
    return started;
}

export function startOnlineResumeScheduler(): void {
    const g = globalThis as { __zuychinOnlineResume?: boolean };
    if (g.__zuychinOnlineResume || !resumeEnabled()) return;
    g.__zuychinOnlineResume = true;
    const scan = () => { void resumeOnlineCouncils().then((n) => { if (n) log(`resumed ${n} council(s)`); }).catch((error) => console.warn("[OnlineCouncil] resume scan failed:", error)); };
    setTimeout(() => {
        scan();
        setInterval(scan, RESUME_SCAN_MS).unref();
    }, RESUME_FIRST_SCAN_MS).unref();
}

export interface SeatOption {
    key: string;
    label: string;
    provider: string;
    providerId: string;
    free: boolean;
    speed: "fast" | "medium" | "slow" | "unknown";
    tags: PurposeTag[];
    status: "new" | "missing" | null;
}

/** The selectable list, with speed and tags. Under Free only it holds free models alone. */
export function seatOptions(freeOnly: boolean): SeatOption[] {
    const roster = new Map(currentRoster({ freeOnly: false, paidOrchestrator: true, unattended: false }).map((e) => [e.key, e]));
    return availableChatModels(freeOnly).flatMap((group) => group.models.map((model) => {
        const key = `${group.providerId}::${model.id}`;
        const entry = roster.get(key);
        const resolved = resolveModelKey(key);
        return {
            key, label: model.label, provider: group.provider, providerId: group.providerId,
            free: resolved ? !isPaidModel(resolved) : entry ? !entry.paid : false,
            speed: entry?.speed.tier ?? "unknown", tags: entry?.tags ?? [], status: model.status ?? null,
        };
    })).filter((option) => !freeOnly || option.free);
}

export function autoFillSeats(count: number, purpose: PurposeTag, exclude: readonly string[] = []): string[] {
    const roster = currentRoster({ freeOnly: true, paidOrchestrator: false, unattended: false });
    const candidates = listForRun(roster, purpose, { tools: false, vision: false })
        .filter((e) => !e.paid && e.status === null && !exclude.includes(e.key));
    return pickDiverse(candidates, count, purpose);
}

const CHAT_DEFAULT_SEATS = 3;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Chat tools may give names, model keys, both or neither; empty model slots get free models from auto-fill. */
export function chatSeats(raw: unknown, purpose: PurposeTag): { ok: true; seats: OnlineSeatInput[] } | { ok: false; error: string } {
    // An empty object is still a seat: "three seats, you pick" arrives as [{}, {}, {}].
    const given = (Array.isArray(raw) ? raw : []).filter((entry) => entry && typeof entry === "object").map((entry) => {
        const s = entry as Record<string, unknown>;
        return { name: text(s.name), expertise: text(s.expertise), modelKey: text(s.modelKey) };
    });
    const rows = given.length ? given : Array.from({ length: CHAT_DEFAULT_SEATS }, () => ({ name: "", expertise: "", modelKey: "" }));
    const missing = rows.filter((s) => !s.modelKey).length;
    const picks = missing ? autoFillSeats(missing, purpose, rows.map((s) => s.modelKey).filter(Boolean)) : [];
    if (picks.length < missing) {
        return { ok: false, error: `Only ${picks.length} free model(s) are available for ${missing} empty seat(s). Name the models (model_status lists keys) or use fewer seats.` };
    }
    return {
        ok: true,
        seats: rows.map((s) => ({
            name: s.name || undefined, expertise: s.expertise || undefined,
            ...(s.modelKey ? { modelKey: s.modelKey, source: "picker" } : { modelKey: picks.shift()!, source: `auto:${purpose}` }),
        })),
    };
}

/** Checks a chat proposal against the live list without convening anything. */
export async function checkOnlineSeats(seats: OnlineSeatInput[], allowPaid: boolean, deps: OnlineDeps = onlineDeps()) {
    return resolveSeats(seats, { freeOnly: await deps.freeOnly(), allowPaid }, deps.resolve);
}

