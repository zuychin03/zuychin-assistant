import { MODEL } from "@/lib/gemini";
import { runGeminiLoop } from "@/lib/ai/agent/gemini-loop";
import { runWorker } from "@/lib/ai/agent/worker";
import { AGENT_TOOLS } from "@/lib/ai/agent/tools";
import { AGENT_CONFIG } from "@/lib/ai/agent/config";
import { executeTool, geminiDeclarationsFor, MCP_TOOLS, WEB_SEARCH_TOOL, type ToolContext } from "@/lib/ai/mcp-service";
import { ARTIFACT_TOOLS } from "@/lib/ai/tools/artifacts";
import { buildSkillIndexAsync, getSkillInstructionsAsync } from "@/lib/ai/skills/registry";
import { createDraftSkill } from "@/lib/ai/skills/custom-store";
import { createAgentRun, RunEventBuffer } from "@/lib/ai/agent/run-store";
import { isJournalled, journalledCall } from "@/lib/ai/agent/journal";
import { getProviderApiKey } from "@/lib/ai/providers";
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

    const isGemini = rag.chat.provider.kind === "gemini";
    const model = isGemini ? rag.chat.model.id : MODEL;
    // Only honour the chosen provider's key when its model is the one running;
    // the MODEL fallback belongs to the default project.
    const geminiApiKey = isGemini ? getProviderApiKey(rag.chat.provider) : undefined;
    const created = await createAgentRun({
        message, conversationId, userProfileId, model, resumeRunId: opts.resumeRunId,
    });
    const runId = created?.id ?? null;
    const rootRunId = created?.rootRunId ?? null;
    const runBuffer = new RunEventBuffer(runId);
    const onEvent = runBuffer.wrap(opts.onEvent);
    if (runId) onEvent({ type: "run", runId });

    const artifacts: ArtifactDescriptor[] = [];
    let councilProposal: CouncilProposal | undefined;
    const toolCtx: ToolContext = {
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
    let workerTokens = 0;
    let subagentTimeouts = 0;

    async function runSubagents(args: Record<string, unknown>): Promise<string> {
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const remaining = Math.max(0, AGENT_CONFIG.maxTotalSubagents - subagentsSpawned);
        const tasks = rawTasks.slice(0, Math.min(AGENT_CONFIG.maxSubagentsPerCall, remaining));
        if (tasks.length === 0) return "No worker capacity remaining - handle the rest yourself.";
        subagentsSpawned += tasks.length;

        const results = await Promise.all(
            tasks.map(async (t) => {
                const task = t as { objective?: unknown; model?: unknown; needs_tools?: unknown; complexity?: unknown };
                const objective = String(task.objective ?? "").trim();
                if (!objective) return "(skipped: empty objective)";
                const modelHint = task.model ? String(task.model) : undefined;
                const needsTools = task.needs_tools !== false;
                const complexity = task.complexity === "complex" ? "complex" as const : "simple" as const;

                onEvent?.({ type: "subagent", objective, model: modelHint ?? "auto", phase: "start" });
                const { value: res, timedOut } = await withDeadline(
                    (workerSignal) => runWorker({
                        objective, modelHint, needsTools, complexity,
                        contextBlock: rag.contextBlock, embRef: rag.embRef, toolCtx, signal: workerSignal,
                    }),
                    AGENT_CONFIG.workerTimeoutMs,
                    signal,
                    { model: modelHint ?? "auto", output: "(stopped at its deadline; no result)", tokens: 0 },
                );
                if (timedOut) subagentTimeouts++;
                workerTokens += res.tokens;
                onEvent?.({ type: "subagent", objective, model: res.model, phase: "done" });
                return `### Worker result - ${objective}\n(model: ${res.model})\n${res.output}`;
            })
        );

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
    try {
        const { text: reply, usage, stopReason } = await runGeminiLoop({
            model,
            apiKey: geminiApiKey,
            systemPrompt: `${AGENT_SYSTEM}\n\nSKILLS - proven playbooks for common task types. When one fits, call use_skill(skill_id) to load its full steps before you carry out that work:\n${skillIndex}\n\n${rag.contextBlock}`,
            userMessage: resumePrefix ? `${resumePrefix}${message}` : message,
            toolDeclarations: geminiDeclarationsFor([...MCP_TOOLS, WEB_SEARCH_TOOL, ...ARTIFACT_TOOLS, ...AGENT_TOOLS]),
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
