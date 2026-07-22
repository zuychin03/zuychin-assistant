import { Type } from "@google/genai";
import { ai, MODEL } from "@/lib/gemini";
import { getCronState, setCronState, listCronStateByPrefix, deleteCronState } from "@/lib/cron-state";
import { addTodo } from "@/lib/db";
import { ingestToVault } from "@/lib/vault/ingest";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import { notify } from "./router";
import {
    sendSlackMessage,
    listAgents,
    mentionFor,
    identifyAgent,
    type SlackMessageEvent,
} from "./slack-service";

// Zuychin conducts a co-working thread: it addresses ONE agent per turn, reads
// the reply via the Slack webhook, and decides the next step. Loop guards are
// non-negotiable with several autonomous agents in one room.

const MAX_TURNS = 12;              // hard cap per thread
const MAX_MENTIONS_PER_AGENT = 5;  // per-agent cap

interface ThreadEntry {
    from: string;
    text: string;
}

interface ThreadState {
    channel: string;
    threadTs: string;
    task: string;
    status: "active" | "done" | "capped";
    turns: number;
    mentionsByAgent: Record<string, number>;
    transcript: ThreadEntry[];
    awaiting: string | null;
    updatedAt: string;
    finishedAt?: string;
    escalated?: boolean;
}

export const SLACK_THREAD_PREFIX = "slack_thread:";

function stateKey(threadTs: string): string {
    return `${SLACK_THREAD_PREFIX}${threadTs}`;
}

async function loadState(threadTs: string): Promise<ThreadState | null> {
    try {
        return await getCronState<ThreadState & Record<string, unknown>>(stateKey(threadTs));
    } catch (err) {
        console.error("[Slack] Thread state unreadable:", err);
        return null;
    }
}

async function saveState(state: ThreadState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await setCronState(stateKey(state.threadTs), state as unknown as Record<string, unknown>);
}

export async function isTrackedThread(threadTs: string): Promise<boolean> {
    return (await loadState(threadTs)) !== null;
}

// --- Watchdog / standup support (consumed by the cron endpoints) ---

export interface StalledThread {
    threadTs: string;
    channel: string;
    task: string;
    awaiting: string | null;
    staleMinutes: number;
}

export async function listStalledThreads(staleMinutes: number): Promise<StalledThread[]> {
    const rows = await listCronStateByPrefix<ThreadState>(SLACK_THREAD_PREFIX);
    const now = Date.now();
    const out: StalledThread[] = [];
    for (const { value: s } of rows) {
        if (s.status !== "active" || !s.awaiting || s.escalated) continue;
        const ageMin = (now - Date.parse(s.updatedAt)) / 60000;
        if (ageMin >= staleMinutes) {
            out.push({ threadTs: s.threadTs, channel: s.channel, task: s.task, awaiting: s.awaiting, staleMinutes: Math.round(ageMin) });
        }
    }
    return out;
}

export async function markEscalated(threadTs: string): Promise<void> {
    const s = await loadState(threadTs);
    if (!s) return;
    s.escalated = true;
    await saveState(s);
}

export interface FinishedThread {
    task: string;
    status: string;
    turns: number;
    finishedAt: string;
}

export async function listRecentlyFinished(sinceMs: number): Promise<FinishedThread[]> {
    const rows = await listCronStateByPrefix<ThreadState>(SLACK_THREAD_PREFIX);
    const cutoff = Date.now() - sinceMs;
    return rows
        .map((r) => r.value)
        .filter((s) => s.status !== "active" && !!s.finishedAt && Date.parse(s.finishedAt) >= cutoff)
        .map((s) => ({ task: s.task, status: s.status, turns: s.turns, finishedAt: s.finishedAt! }));
}

export async function pruneOldThreads(olderThanMs: number): Promise<number> {
    const rows = await listCronStateByPrefix<ThreadState>(SLACK_THREAD_PREFIX);
    const cutoff = Date.now() - olderThanMs;
    let pruned = 0;
    for (const { key, value: s } of rows) {
        const ts = Date.parse(s.finishedAt ?? s.updatedAt);
        if (s.status !== "active" && Number.isFinite(ts) && ts < cutoff) {
            await deleteCronState(key);
            pruned++;
        }
    }
    return pruned;
}

interface Decision {
    action: "address" | "complete";
    agentLabel?: string;
    message?: string;
    summary?: string;
}

async function decideNext(state: ThreadState): Promise<Decision> {
    const roster = listAgents().map((a) => a.label);
    const transcript = state.transcript.map((e) => `${e.from}: ${e.text}`).join("\n") || "(no replies yet)";

    const prompt = `You are Zuychin, orchestrating a team of AI coding agents in a Slack thread to accomplish a task. Decide the single next step.

Task:
${state.task}

Available agents: ${roster.join(", ") || "(none configured)"}

Thread so far:
${transcript}

Rules:
- Address ONE agent at a time. Give a clear, self-contained instruction that references prior work by pointer (a PR, a file path, a vault page), never by pasting large content.
- Choose "complete" when the task is finished or no further agent work would help, and give a one-paragraph summary of the outcome.
- Keep messages concise and action-oriented.`;

    const res = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    action: { type: Type.STRING, enum: ["address", "complete"] },
                    agentLabel: { type: Type.STRING, description: "Which agent to address next (when action=address)." },
                    message: { type: Type.STRING, description: "The instruction to post (when action=address)." },
                    summary: { type: Type.STRING, description: "Outcome summary (when action=complete)." },
                },
                required: ["action"],
            },
        },
    });

    const parsed = JSON.parse(res.text ?? "{}") as Decision;
    return parsed;
}

// Zuychin is @mentioned with a task -> plan and address the first agent.
export async function startCoworkingThread(channel: string, task: string, rootTs: string): Promise<void> {
    if (!task.trim()) return;

    const state: ThreadState = {
        channel,
        threadTs: rootTs,
        task: task.trim(),
        status: "active",
        turns: 0,
        mentionsByAgent: {},
        transcript: [],
        awaiting: null,
        updatedAt: new Date().toISOString(),
    };

    if (listAgents().length === 0) {
        await sendSlackMessage(channel, "No co-working agents are configured (set SLACK_AGENTS). I can't delegate this yet.", { threadTs: rootTs });
        state.status = "done";
        await saveState(state);
        return;
    }

    await saveState(state);
    const decision = await decideNext(state).catch((err) => {
        console.error("[Slack] Initial decide failed:", err);
        return null;
    });
    if (!decision) return;
    await applyDecision(state, decision);
}

// An agent replied in a tracked thread -> record it, enforce caps, decide next.
export async function handleThreadReply(event: SlackMessageEvent): Promise<void> {
    const threadTs = event.thread_ts;
    if (!threadTs) return;
    const state = await loadState(threadTs);
    if (!state || state.status !== "active") return;

    const agent = identifyAgent(event);
    if (!agent) return; // only agent replies drive turns

    state.transcript.push({ from: agent, text: (event.text ?? "").slice(0, 2000) });
    state.turns += 1;
    state.awaiting = null;

    if (state.turns >= MAX_TURNS) {
        await finalize(state, "capped", `Reached the ${MAX_TURNS}-turn cap for this thread.`);
        return;
    }

    const decision = await decideNext(state).catch((err) => {
        console.error("[Slack] Decide failed:", err);
        return null;
    });
    if (!decision) {
        await saveState(state);
        return;
    }
    await applyDecision(state, decision);
}

async function applyDecision(state: ThreadState, decision: Decision): Promise<void> {
    if (decision.action === "complete") {
        await finalize(state, "done", decision.summary ?? "Task complete.");
        return;
    }

    const label = decision.agentLabel ?? "";
    const known = listAgents().some((a) => a.label === label);
    if (!known) {
        await finalize(state, "done", `Stopping: model tried to address an unknown agent "${label}".`);
        return;
    }

    const used = state.mentionsByAgent[label] ?? 0;
    if (used >= MAX_MENTIONS_PER_AGENT) {
        await finalize(state, "capped", `Hit the per-agent mention cap for ${label}.`);
        return;
    }

    state.mentionsByAgent[label] = used + 1;
    state.awaiting = label;
    await saveState(state);
    await sendSlackMessage(state.channel, `${mentionFor(label)} ${decision.message ?? ""}`.trim(), {
        threadTs: state.threadTs,
    });
}

async function finalize(state: ThreadState, status: "done" | "capped", note: string): Promise<void> {
    state.status = status;
    state.finishedAt = new Date().toISOString();
    await saveState(state);
    await sendSlackMessage(state.channel, `✅ ${note}`, { threadTs: state.threadTs });
    await handoffToDiscord(state, note);
    await maybeIngestToVault(state);
}

// Bridge the agent war-room to the life-ops dashboard: post a plain-English
// summary to #coworking-log, and file a follow-up todo when a thread stalled.
async function handoffToDiscord(state: ThreadState, note: string): Promise<void> {
    const summary = `🤝 **Co-working thread ${state.status}**\n**Task:** ${state.task}\n**Turns:** ${state.turns}\n${note}`;
    await notify("agent_run_complete", summary).catch((e) => console.warn("[Slack] Discord handoff failed:", e));

    if (state.status === "capped") {
        await addTodo({
            title: `Follow up on stalled co-working: ${state.task.slice(0, 80)}`,
            description: note,
            priority: "medium",
        }).catch((e) => console.warn("[Slack] Follow-up todo failed:", e));
    }
}

// Opt-in (SLACK_VAULT_INGEST=1): keep a durable decision log of substantive
// threads, since Slack's free tier drops history after 90 days.
async function maybeIngestToVault(state: ThreadState): Promise<void> {
    if (process.env.SLACK_VAULT_INGEST !== "1") return;
    if (state.transcript.length < 2) return;
    try {
        const embRef = await vaultEmbeddingRef();
        const content = [
            `Task: ${state.task}`,
            "",
            ...state.transcript.map((e) => `**${e.from}:** ${e.text}`),
            "",
            `Outcome (${state.status}): ${state.finishedAt ?? ""}`,
        ].join("\n");
        await ingestToVault({
            title: `Co-working: ${state.task.slice(0, 60)}`,
            content,
            category: "synthesis",
            source: "slack-coworking",
            embRef,
        });
    } catch (e) {
        console.warn("[Slack] Vault ingest failed:", e);
    }
}
