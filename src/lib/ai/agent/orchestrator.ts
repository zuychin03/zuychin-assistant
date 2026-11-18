import { assertFreeModel, resolveFreeChat, freeToolRefusal } from "@/lib/ai/model-policy";
import { MODEL } from "@/lib/gemini";
import { runGeminiLoop } from "@/lib/ai/agent/gemini-loop";
import { runWorker } from "@/lib/ai/agent/worker";
import { addTokenCounts } from "@/lib/ai/stream-usage";
import { AGENT_TOOLS } from "@/lib/ai/agent/tools";
import { AGENT_CONFIG } from "@/lib/ai/agent/config";
import { executeTool, geminiDeclarationsFor, MCP_TOOLS, WEB_SEARCH_TOOL, type ToolContext } from "@/lib/ai/mcp-service";
import { ARTIFACT_TOOLS } from "@/lib/ai/tools/artifacts";
import { buildSkillIndexAsync, getSkillInstructionsAsync } from "@/lib/ai/skills/registry";
import { createDraftSkill } from "@/lib/ai/skills/custom-store";
import { createAgentRun, RunEventBuffer } from "@/lib/ai/agent/run-store";
import { isJournalled, journalledCall } from "@/lib/ai/agent/journal";
import { getProviderApiKey, providers, type ResolvedChat } from "@/lib/ai/providers";
import { createModelToolkit, MODEL_TOOL_NAMES, MODEL_TOOLS, parsePurpose } from "@/lib/ai/agent/model-tools";
import { currentRoster, formatRosterSummary, type RosterEntry, type RosterPolicy } from "@/lib/ai/models/roster";
import { consultModel } from "@/lib/ai/models/consult";
import { insertFeedback } from "@/lib/ai/models/store";
import { isUnattendedRun } from "@/lib/tasks/unattended-policy";
import type { PurposeTag } from "@/lib/ai/models/tags";
import type { AgentEventSink, PlanStep } from "@/lib/ai/agent/events";
import type { RagContext } from "@/lib/ai/rag-service";
import type { ArtifactDescriptor, CouncilProposal } from "@/lib/types";

const AGENT_SYSTEM = `You are Zuychin's autonomous agent. Resolve the user's request end-to-end:
1. Call update_plan first with a short plan (2–6 steps), and update it as you progress.
2. Carry out the steps using your tools. Call search_web whenever you need current, factual, or up-to-date information - don't rely on stale knowledge for research.
3. When subtasks are independent, call run_subagents to do them in parallel and save time. Sub-agents only gather information and return findings as text - they do NOT create files. You are the SOLE author of the deliverables: gather everything first, then synthesize it yourself.
4. You alone produce the output files: use create_document (reports/write-ups) or create_code_file / create_code_bundle (code) - never paste large file contents into the chat. Produce exactly what the user asked for and no more: if they asked for "a PDF report", create ONE document. Never create duplicate or overlapping files for the same deliverable.
5. When everything is done, reply with a concise summary of what you produced (the files are attached automatically).
6. If you just completed a novel multi-step procedure the user is likely to ask for again, you may call save_skill ONCE to save it as a draft playbook for review - never for one-offs or anything the skill index already covers.
7. Pick models on purpose: give each run_subagents task a purpose so the app picks the best measured free model for it. Call list_models when the choice matters, and ask_model or compare_models only when a second opinion is worth it (6 calls per run). After you have used sub-agent results, call rate_workers once.
Be decisive and keep going until the task is fully resolved.`;

// Aborts the worker instead of abandoning it. The previous shape resolved a
// fallback and left the worker running with full tool access, so a subtask the
// lead had already written off could still be calling tools - and the lead
// synthesized its deliverable around a result that never arrived.
async function withDeadline<T>(
    start: (signal: AbortSignal) => Promise<T>,
    ms: number,
    parent: AbortSignal | undefined,
    fallback: T,
): Promise<{ value: T; timedOut: boolean }> {
    const controller = new AbortController();
    const relay = () => controller.abort(parent?.reason);
    parent?.addEventListener("abort", relay, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("worker deadline"));
    }, ms);
    try {
        return { value: await start(controller.signal), timedOut: false };
    } catch (e) {
        // A user cancel belongs to the whole run, not just this worker.
        if (parent?.aborted) throw e;
        if (!timedOut) console.warn("[Agent] subagent failed:", e);
        return { value: fallback, timedOut };
    } finally {
        clearTimeout(timer);
        parent?.removeEventListener("abort", relay);
    }
}

function resolveEntry(entry: RosterEntry): ResolvedChat | null {
    const provider = providers().find((candidate) => candidate.id === entry.providerId);
    const model = provider?.chatModels.find((candidate) => candidate.id === entry.modelId);
    return provider && model ? { provider, model } : null;
}

function normalizeSteps(raw: unknown): PlanStep[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .slice(0, 8)
        .map((s) => {
            const step = s as { title?: unknown; status?: unknown };
            const status = String(step.status ?? "pending");
            return {
                title: String(step.title ?? "").slice(0, 200),
                status: (["pending", "in_progress", "done"].includes(status) ? status : "pending") as PlanStep["status"],
            };
        })
        .filter((s) => s.title.length > 0);
}

export async function runAgent(opts: {
    rag: RagContext;
    message: string;
    conversationId?: string;
    userProfileId?: string;
    onEvent?: AgentEventSink;
    resumePrefix?: string;
    resumeRunId?: string;
    signal?: AbortSignal;
}): Promise<{ reply: string; artifacts: ArtifactDescriptor[]; steps: PlanStep[]; councilProposal?: CouncilProposal }> {
    const { rag, message, conversationId, userProfileId, resumePrefix, signal } = opts;

    const lead = rag.freeOnly ? resolveFreeChat(rag.chat, true) : rag.chat;
    if (rag.freeOnly) assertFreeModel(lead);
    const isGemini = lead.provider.kind === "gemini";
    const model = isGemini ? lead.model.id : MODEL;
    // Only honour the chosen provider's key when its model is the one running;
    // the MODEL fallback belongs to the default project.
    const geminiApiKey = isGemini ? getProviderApiKey(lead.provider) : undefined;
    const created = await createAgentRun({
        message, conversationId, userProfileId, model, resumeRunId: opts.resumeRunId,
    });
    const runId = created?.id ?? null;
    const rootRunId = created?.rootRunId ?? null;
    const runBuffer = new RunEventBuffer(runId);
    const onEvent = runBuffer.wrap(opts.onEvent);
    if (runId) onEvent({ type: "run", runId });

    // Hints and consult calls may use paid models only when this orchestrator itself runs on the paid key.
    const unattended = rag.paidOnly === true || isUnattendedRun();
    const policy: RosterPolicy = {
        freeOnly: rag.freeOnly === true,
        paidOrchestrator: !rag.freeOnly && !unattended && (!isGemini || lead.provider.id === "gemini"),
        unattended,
    };
    const models = createModelToolkit(policy, {
        roster: () => currentRoster(policy),
        resolve: resolveEntry,
        consult: (resolved, prompt, maxTokens, consultSignal) => consultModel(resolved, prompt, maxTokens, rag.embRef, consultSignal),
        saveFeedback: insertFeedback,
        now: Date.now,
    }, { runId, signal });

    const artifacts: ArtifactDescriptor[] = [];
    let councilProposal: CouncilProposal | undefined;
    const toolCtx: ToolContext = {
        freeOnly: rag.freeOnly,
        conversationId,
        userProfileId,
        onArtifact: (a) => {
            artifacts.push(a);
            onEvent?.({ type: "artifact", artifact: a });
        },
        onCouncilProposal: (p) => { councilProposal = p; },
    };

    let steps: PlanStep[] = [];
    let subagentsSpawned = 0;
    let workerTokens: number | null = 0;
    let subagentTimeouts = 0;

    async function runSubagents(args: Record<string, unknown>): Promise<string> {
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const remaining = Math.max(0, AGENT_CONFIG.maxTotalSubagents - subagentsSpawned);
        const tasks = rawTasks.slice(0, Math.min(AGENT_CONFIG.maxSubagentsPerCall, remaining));
        if (tasks.length === 0) return "No worker capacity remaining - handle the rest yourself.";
        subagentsSpawned += tasks.length;

        const autoFeedback: { providerId: string; modelId: string; purpose: PurposeTag | null; reason: string }[] = [];
        const results = await Promise.all(
            tasks.map(async (t) => {
                const task = t as { objective?: unknown; model?: unknown; needs_tools?: unknown; complexity?: unknown; purpose?: unknown };
                const objective = String(task.objective ?? "").trim();
                if (!objective) return "(skipped: empty objective)";
                const modelHint = task.model ? String(task.model) : undefined;
                const needsTools = task.needs_tools !== false;
                const complexity = task.complexity === "complex" ? "complex" as const : "simple" as const;
                const parsed = parsePurpose(task.purpose);
                const purpose = parsed === "invalid" ? null : parsed;
                const pick = models.pickWorker({ hint: modelHint, purpose, needsTools });
                const notes = [parsed === "invalid" ? `Unknown purpose "${String(task.purpose)}" was ignored.` : null, pick.note].filter(Boolean);
                let lastAttempt: ResolvedChat | null = null;

                onEvent?.({ type: "subagent", objective, model: modelHint ?? (purpose ? `auto for ${purpose}` : "auto"), phase: "start" });
                const { value: res, timedOut } = await withDeadline(
                    (workerSignal) => runWorker({
                        objective, pick, needsTools, complexity, paidOnly: rag.paidOnly, freeOnly: rag.freeOnly,
                        contextBlock: rag.contextBlock, embRef: rag.embRef, toolCtx, signal: workerSignal,
                        onAttempt: (resolved) => { lastAttempt = resolved; },
                        onEmpty: (resolved) => { autoFeedback.push({ providerId: resolved.provider.id, modelId: resolved.model.id, purpose, reason: "Returned an empty answer" }); },
                    }),
                    AGENT_CONFIG.workerTimeoutMs,
                    signal,
                    { providerId: "", model: modelHint ?? "auto", output: "(stopped at its deadline; no result)", tokens: null },
                );
                if (timedOut) {
                    subagentTimeouts++;
                    const stopped = lastAttempt as ResolvedChat | null;
                    if (stopped) autoFeedback.push({ providerId: stopped.provider.id, modelId: stopped.model.id, purpose, reason: "Stopped at the worker deadline" });
                }
                workerTokens = addTokenCounts(workerTokens, res.tokens);
                onEvent?.({ type: "subagent", objective, model: res.model, phase: "done" });
                const modelId = res.model.replace(/ \(fallback\)$/, "");
                const id = res.providerId ? models.registerWorker({ providerId: res.providerId, modelId, purpose }) : null;
                const key = res.providerId ? `${res.providerId}::${modelId}${res.model.endsWith("(fallback)") ? ", paid fallback" : ""}` : "no model finished";
                return `### Worker ${id ?? "(unrated)"} (${key}${purpose ? `, purpose ${purpose}` : ""}) - ${objective}\n${notes.length ? `${notes.join(" ")}\n` : ""}${res.output}`;
            })
        );
        await models.autoFeedback(autoFeedback);

        return results.join("\n\n---\n\n");
    }

    const dispatch = async (name: string, args: Record<string, unknown>): Promise<string> => {
        if (name === "update_plan") {
            steps = normalizeSteps(args.steps);
            onEvent?.({ type: "plan", steps });
            return "Plan recorded. Continue executing it.";
        }
        if (name === "run_subagents") {
            return runSubagents(args);
        }
        if (MODEL_TOOL_NAMES.has(name)) {
            onEvent?.({ type: "tool", name, phase: "start" });
            const result = name === "list_models" ? models.listModels(args)
                : name === "ask_model" ? await models.askModel(args)
                    : name === "compare_models" ? await models.compareModels(args)
                        : await models.rateWorkers(args);
            onEvent?.({ type: "tool", name, phase: "done" });
            return result;
        }
        if (name === "use_skill") {
            onEvent?.({ type: "tool", name, phase: "start" });
            const instructions = await getSkillInstructionsAsync(String(args.skill_id ?? ""));
            onEvent?.({ type: "tool", name, phase: "done" });
            return instructions;
        }
        if (name === "save_skill") {
            onEvent?.({ type: "tool", name, phase: "start" });
            const result = await createDraftSkill({
                slug: String(args.slug ?? ""),
                name: String(args.name ?? ""),
                whenToUse: String(args.when_to_use ?? ""),
                instructions: String(args.instructions ?? ""),
            });
            onEvent?.({ type: "tool", name, phase: "done" });
            return result.ok
                ? `Draft skill saved. It will become usable once the user approves it in the admin panel - mention this in your final reply.`
                : `Could not save the skill: ${result.reason}`;
        }
        const refusal = freeToolRefusal(name, rag.freeOnly);
        if (refusal) return refusal;
        onEvent?.({ type: "tool", name, phase: "start" });
        // Mutations go through the journal so a resumption cannot repeat one.
        const result = isJournalled(name)
            ? await journalledCall({
                rootRunId, runId, tool: name, args,
                run: () => executeTool(name, args, rag.embRef, toolCtx),
            })
            : await executeTool(name, args, rag.embRef, toolCtx);
        onEvent?.({ type: "tool", name, phase: "done" });
        return result;
    };

    onEvent?.({ type: "status", message: "Planning…" });
    const skillIndex = await buildSkillIndexAsync();
    const rosterSummary = formatRosterSummary(currentRoster(policy), policy);
    try {
        const { text: reply, usage, stopReason } = await runGeminiLoop({
            providerId: isGemini ? lead.provider.id : "gemini",
            purpose: "orchestration",
            model,
            apiKey: geminiApiKey,
            systemPrompt: `${AGENT_SYSTEM}${rosterSummary ? `\n\n${rosterSummary}` : ""}\n\nSKILLS - proven playbooks for common task types. When one fits, call use_skill(skill_id) to load its full steps before you carry out that work:\n${skillIndex}\n\n${rag.contextBlock}`,
            userMessage: resumePrefix ? `${resumePrefix}${message}` : message,
            toolDeclarations: geminiDeclarationsFor([...MCP_TOOLS, WEB_SEARCH_TOOL, ...ARTIFACT_TOOLS, ...AGENT_TOOLS, ...MODEL_TOOLS]),
            dispatch,
            maxRounds: AGENT_CONFIG.maxIterations,
            thinking: rag.allowThinking,
            signal,
        });
        // A run that ended with subtasks unfinished is not the same as one that
        // finished, even when the reply reads fine.
        await runBuffer.finish({
            status: "done",
            stopReason: subagentTimeouts > 0 && stopReason === "complete" ? "partial_worker_timeout" : stopReason,
            reply,
            usage: { ...usage, workerTokens },
        });
        return { reply, artifacts, steps, councilProposal };
    } catch (err) {
        await runBuffer.finish({
            status: "error",
            stopReason: signal?.aborted ? "cancelled" : "error",
            error: err instanceof Error ? err.message : String(err),
            usage: { workerTokens },
        });
        throw err;
    }
}
