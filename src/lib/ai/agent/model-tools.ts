import type { McpTool } from "@/lib/ai/mcp-service";
import type { ResolvedChat } from "@/lib/ai/providers";
import { AGENT_CONFIG } from "@/lib/ai/agent/config";
import { findEntry, formatModelDetail, formatRoster, rankForPurpose, type RosterEntry, type RosterPolicy } from "@/lib/ai/models/roster";
import { isPurposeTag, PURPOSE_TAGS, type PurposeTag } from "@/lib/ai/models/tags";
import type { FeedbackInput } from "@/lib/ai/models/store";

const TAG_LIST = PURPOSE_TAGS.join(", ");
const ASK_ANSWER_MAX = 6000;
const COMPARE_ANSWER_MAX = 2000;
const DEFAULT_CONSULT_TOKENS = 1500;
const MAX_CONSULT_TOKENS = 4000;

export const MODEL_TOOLS: McpTool[] = [
    {
        name: "list_models",
        description: "List the chat models this run may use, best first for a purpose, with measured speed, success rate, purpose tags and worker ratings. Pass model to read one model's strengths, weaknesses and measured problems. Calls no model.",
        parameters: {
            purpose: { type: "string", description: `Optional purpose tag: ${TAG_LIST}.`, required: false },
            needs_tools: { type: "boolean", description: "Only models that support tool calls.", required: false },
            needs_vision: { type: "boolean", description: "Only models that accept images.", required: false },
            model: { type: "string", description: "A provider::model key or a model name, for the full profile of one model.", required: false },
        },
    },
    {
        name: "ask_model",
        description: "Ask one other model a question and get its answer, with no tools. Use it for a second opinion or a task one model is known to do well. Shares a budget of 6 calls per run with compare_models. Paid models are allowed only when this run's orchestrator is on a paid model.",
        parameters: {
            model: { type: "string", description: "A provider::model key from list_models, or a model name.", required: true },
            prompt: { type: "string", description: "The full, self-contained request. The model sees nothing else.", required: true },
            max_tokens: { type: "number", description: `Answer length cap, default ${DEFAULT_CONSULT_TOKENS}, at most ${MAX_CONSULT_TOKENS}.`, required: false },
        },
    },
    {
        name: "compare_models",
        description: "Send one prompt to 2 or 3 models in parallel, with no tools, and get each answer with its time. Use it before relying on an unfamiliar model for a kind of task. Each model counts toward the 6 consult calls per run.",
        parameters: {
            prompt: { type: "string", description: "The full, self-contained request.", required: true },
            models: { type: "array", description: "2 or 3 provider::model keys or model names.", required: true, items: { type: "string", description: "A model key or name." } },
        },
    },
    {
        name: "rate_workers",
        description: "Rate this run's sub-agent results once, after you have used them. Ratings are stored with each worker's model and purpose and steer later automatic picks.",
        parameters: {
            ratings: {
                type: "array",
                description: "One rating per worker you can judge.",
                required: true,
                items: {
                    type: "object",
                    description: "A rating for one worker.",
                    properties: {
                        worker: { type: "string", description: "The worker id from its result header, such as w2.", required: true },
                        useful: { type: "boolean", description: "Whether its result was useful for the final answer.", required: true },
                        reason: { type: "string", description: "A few words on why.", required: false },
                    },
                },
            },
        },
    },
];

export const MODEL_TOOL_NAMES = new Set(MODEL_TOOLS.map((tool) => tool.name));

export interface ModelToolDeps {
    roster(): RosterEntry[];
    resolve(entry: RosterEntry): ResolvedChat | null;
    consult(resolved: ResolvedChat, prompt: string, maxTokens: number, signal: AbortSignal): Promise<string>;
    saveFeedback(rows: readonly FeedbackInput[]): Promise<boolean>;
    now(): number;
}

export interface WorkerPick {
    /** Hint and purpose picks, tried before anything else. */
    candidates: ResolvedChat[];
    /** True when the worker should still try today's default chain after these. */
    defaultChain: boolean;
    /** Shown in the result header when a hint was not used. */
    note: string | null;
}

interface WorkerRecord {
    providerId: string;
    modelId: string;
    purpose: PurposeTag | null;
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text;
const secondsText = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function parsePurpose(raw: unknown): PurposeTag | null | "invalid" {
    if (raw === undefined || raw === null || raw === "") return null;
    return isPurposeTag(raw) ? raw : "invalid";
}

export function createModelToolkit(policy: RosterPolicy, deps: ModelToolDeps, opts: { runId: string | null; signal?: AbortSignal }) {
    let consultCalls = 0;
    let rated = false;
    let nextWorker = 1;
    const workers = new Map<string, WorkerRecord>();

    function usable(ref: string, roster: readonly RosterEntry[]): { entry: RosterEntry; resolved: ResolvedChat } | string {
        const entry = findEntry(roster, ref);
        if (!entry) return `No model matches "${ref}". Call list_models for the keys this run may use.`;
        if (!entry.hintEligible) return `${entry.key} is not usable on this run: ${entry.reason}.`;
        const resolved = deps.resolve(entry);
        return resolved ? { entry, resolved } : `${entry.key} could not be resolved.`;
    }

    async function timedConsult(resolved: ResolvedChat, prompt: string, maxTokens: number): Promise<{ ok: true; text: string; ms: number } | { ok: false; error: string; ms: number }> {
        const started = deps.now();
        const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(AGENT_CONFIG.consultTimeoutMs)]) : AbortSignal.timeout(AGENT_CONFIG.consultTimeoutMs);
        try {
            const text = (await deps.consult(resolved, prompt, maxTokens, signal)).trim();
            return text ? { ok: true, text, ms: deps.now() - started } : { ok: false, error: "empty answer", ms: deps.now() - started };
        } catch (error) {
            if (opts.signal?.aborted) throw error;
            const timedOut = signal.aborted;
            return { ok: false, error: timedOut ? `no answer within ${AGENT_CONFIG.consultTimeoutMs / 1000} s` : error instanceof Error ? error.message.slice(0, 200) : String(error), ms: deps.now() - started };
        }
    }

    return {
        policy,

        listModels(args: Record<string, unknown>): string {
            const roster = deps.roster();
            if (typeof args.model === "string" && args.model.trim()) {
                const entry = findEntry(roster, args.model);
                return entry ? formatModelDetail(entry, policy) : `No model matches "${args.model}". Call list_models without model to see the keys.`;
            }
            const purpose = parsePurpose(args.purpose);
            if (purpose === "invalid") return `Unknown purpose "${String(args.purpose)}". Use one of: ${TAG_LIST}.`;
            return formatRoster(roster, policy, purpose, { tools: args.needs_tools === true, vision: args.needs_vision === true });
        },

        /** Candidates for one worker: a usable hint first, then the purpose ranking. Unattended runs leave the worker on paid Gemini. */
        pickWorker(task: { hint?: string; purpose: PurposeTag | null; needsTools: boolean }): WorkerPick {
            if (policy.unattended) return { candidates: [], defaultChain: false, note: task.hint ? "Scheduled run: the model hint was ignored and paid Gemini ran." : null };
            const roster = deps.roster();
            const candidates: ResolvedChat[] = [];
            let note: string | null = null;
            if (task.hint) {
                const found = usable(task.hint, roster);
                if (typeof found === "string") note = `${found} Picked automatically instead.`;
                else candidates.push(found.resolved);
            }
            if (!task.purpose) return { candidates, defaultChain: true, note };
            const ranked = rankForPurpose(roster, task.purpose, { tools: task.needsTools, vision: task.purpose === "vision" })
                .flatMap((entry) => deps.resolve(entry) ?? []);
            candidates.push(...ranked);
            return { candidates, defaultChain: ranked.length === 0, note };
        },

        registerWorker(record: WorkerRecord): string {
            const id = `w${nextWorker++}`;
            workers.set(id, record);
            return id;
        },

        workerKey(id: string): string | null {
            const record = workers.get(id);
            return record ? `${record.providerId}::${record.modelId}` : null;
        },

        async askModel(args: Record<string, unknown>): Promise<string> {
            const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
            if (!prompt || typeof args.model !== "string") return "Send model and prompt.";
            if (consultCalls >= AGENT_CONFIG.maxConsultCalls) return `The consult budget of ${AGENT_CONFIG.maxConsultCalls} calls for this run is used up. Carry on with what you have.`;
            const found = usable(args.model, deps.roster());
            if (typeof found === "string") return found;
            consultCalls += 1;
            const maxTokens = Math.min(MAX_CONSULT_TOKENS, Math.max(64, Math.round(Number(args.max_tokens) || DEFAULT_CONSULT_TOKENS)));
            const result = await timedConsult(found.resolved, prompt, maxTokens);
            if (!result.ok) return `${found.entry.key} failed after ${secondsText(result.ms)}: ${result.error}. ${AGENT_CONFIG.maxConsultCalls - consultCalls} consult calls left.`;
            return `Answer from ${found.entry.key} in ${secondsText(result.ms)} (${AGENT_CONFIG.maxConsultCalls - consultCalls} consult calls left):\n${clip(result.text, ASK_ANSWER_MAX)}`;
        },

        async compareModels(args: Record<string, unknown>): Promise<string> {
            const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
            const refs = Array.isArray(args.models) ? [...new Set(args.models.filter((ref): ref is string => typeof ref === "string" && !!ref.trim()))] : [];
            if (!prompt || refs.length < 2 || refs.length > 3) return "Send a prompt and 2 or 3 models.";
            const roster = deps.roster();
            const picked: { entry: RosterEntry; resolved: ResolvedChat }[] = [];
            const refused: string[] = [];
            for (const ref of refs) {
                const found = usable(ref, roster);
                if (typeof found === "string") refused.push(found);
                else if (!picked.some((entry) => entry.entry.key === found.entry.key)) picked.push(found);
            }
            if (picked.length < 2) return [`Need at least 2 usable models to compare.`, ...refused].join("\n");
            const left = AGENT_CONFIG.maxConsultCalls - consultCalls;
            if (left < picked.length) return `Only ${left} of the ${AGENT_CONFIG.maxConsultCalls} consult calls for this run are left, and this comparison needs ${picked.length}.`;
            consultCalls += picked.length;
            const results = await Promise.all(picked.map(async (entry) => ({ entry: entry.entry, result: await timedConsult(entry.resolved, prompt, DEFAULT_CONSULT_TOKENS) })));
            const lines = results.map(({ entry, result }) => `### ${entry.key}\n${result.ok ? clip(result.text, COMPARE_ANSWER_MAX) : `(failed: ${result.error})`}`);
            const table = ["| Model | Time | Result |", "| --- | --- | --- |", ...results.map(({ entry, result }) => `| ${entry.key} | ${secondsText(result.ms)} | ${result.ok ? "answered" : `failed, ${result.error}`} |`)];
            return [...lines, "", ...table, ...(refused.length ? ["", ...refused] : []), `${AGENT_CONFIG.maxConsultCalls - consultCalls} consult calls left.`].join("\n");
        },

        async rateWorkers(args: Record<string, unknown>): Promise<string> {
            if (rated) return "Workers were already rated on this run.";
            const raw = Array.isArray(args.ratings) ? args.ratings : [];
            const rows: FeedbackInput[] = [];
            const unknown: string[] = [];
            for (const item of raw) {
                const rating = item !== null && typeof item === "object" ? item as Record<string, unknown> : {};
                const id = String(rating.worker ?? "").trim().toLowerCase();
                const record = workers.get(id);
                if (!record || typeof rating.useful !== "boolean") { unknown.push(id || "(blank)"); continue; }
                rows.push({
                    providerId: record.providerId, modelId: record.modelId, purpose: record.purpose, source: "lead", useful: rating.useful,
                    reason: typeof rating.reason === "string" ? rating.reason.slice(0, 200) : null, agentRunId: opts.runId,
                });
            }
            if (!rows.length) return `No ratings matched a worker of this run.${unknown.length ? ` Unknown: ${unknown.join(", ")}.` : ""}`;
            rated = true;
            const saved = await deps.saveFeedback(rows);
            return `${saved ? "Saved" : "Could not save"} ${rows.length} rating${rows.length === 1 ? "" : "s"}.${unknown.length ? ` Skipped: ${unknown.join(", ")}.` : ""}`;
        },

        /** What model health cannot see on its own: an empty answer, or a worker stopped at its deadline. */
        async autoFeedback(entries: { providerId: string; modelId: string; purpose: PurposeTag | null; reason: string }[]): Promise<void> {
            if (!entries.length) return;
            await deps.saveFeedback(entries.map((entry) => ({ ...entry, source: "auto" as const, useful: false, agentRunId: opts.runId }))).catch(() => false);
        },
    };
}

export type ModelToolkit = ReturnType<typeof createModelToolkit>;
