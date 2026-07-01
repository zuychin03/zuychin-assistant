import { MODEL } from "@/lib/gemini";
import { runGeminiLoop } from "@/lib/ai/agent/gemini-loop";
import { runWorker } from "@/lib/ai/agent/worker";
import { AGENT_TOOLS } from "@/lib/ai/agent/tools";
import { AGENT_CONFIG } from "@/lib/ai/agent/config";
import { executeTool, geminiDeclarationsFor, MCP_TOOLS, WEB_SEARCH_TOOL, type ToolContext } from "@/lib/ai/mcp-service";
import { ARTIFACT_TOOLS } from "@/lib/ai/tools/artifacts";
import { buildSkillIndex, getSkillInstructions } from "@/lib/ai/skills/registry";
import type { AgentEventSink, PlanStep } from "@/lib/ai/agent/events";
import type { RagContext } from "@/lib/ai/rag-service";
import type { ArtifactDescriptor } from "@/lib/types";

const AGENT_SYSTEM = `You are Zuychin's autonomous agent. Resolve the user's request end-to-end:
1. Call update_plan first with a short plan (2–6 steps), and update it as you progress.
2. Carry out the steps using your tools. Call search_web whenever you need current, factual, or up-to-date information — don't rely on stale knowledge for research.
3. When subtasks are independent, call run_subagents to do them in parallel and save time. Sub-agents only gather information and return findings as text — they do NOT create files. You are the SOLE author of the deliverables: gather everything first, then synthesize it yourself.
4. You alone produce the output files: use create_document (reports/write-ups) or create_code_file / create_code_bundle (code) — never paste large file contents into the chat. Produce exactly what the user asked for and no more: if they asked for "a PDF report", create ONE document. Never create duplicate or overlapping files for the same deliverable.
5. When everything is done, reply with a concise summary of what you produced (the files are attached automatically).
Be decisive and keep going until the task is fully resolved.`;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); console.warn("[Agent] subagent failed:", e); resolve(fallback); },
        );
    });
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
}): Promise<{ reply: string; artifacts: ArtifactDescriptor[]; steps: PlanStep[] }> {
    const { rag, message, conversationId, userProfileId, onEvent } = opts;

    const artifacts: ArtifactDescriptor[] = [];
    const toolCtx: ToolContext = {
        conversationId,
        userProfileId,
        onArtifact: (a) => {
            artifacts.push(a);
            onEvent?.({ type: "artifact", artifact: a });
        },
    };

    let steps: PlanStep[] = [];
    let subagentsSpawned = 0;

    async function runSubagents(args: Record<string, unknown>): Promise<string> {
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const remaining = Math.max(0, AGENT_CONFIG.maxTotalSubagents - subagentsSpawned);
        const tasks = rawTasks.slice(0, Math.min(AGENT_CONFIG.maxSubagentsPerCall, remaining));
        if (tasks.length === 0) return "No worker capacity remaining — handle the rest yourself.";
        subagentsSpawned += tasks.length;

        const results = await Promise.all(
            tasks.map(async (t) => {
                const task = t as { objective?: unknown; model?: unknown };
                const objective = String(task.objective ?? "").trim();
                if (!objective) return "(skipped: empty objective)";
                const modelHint = task.model ? String(task.model) : undefined;

                onEvent?.({ type: "subagent", objective, model: modelHint ?? "auto", phase: "start" });
                const res = await withTimeout(
                    runWorker({ objective, modelHint, contextBlock: rag.contextBlock, embRef: rag.embRef, toolCtx }),
                    AGENT_CONFIG.workerTimeoutMs,
                    { model: modelHint ?? "auto", output: "(this subtask timed out and produced no result)" },
                );
                onEvent?.({ type: "subagent", objective, model: res.model, phase: "done" });
                return `### Worker result — ${objective}\n(model: ${res.model})\n${res.output}`;
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
            const instructions = getSkillInstructions(String(args.skill_id ?? ""));
            onEvent?.({ type: "tool", name, phase: "done" });
            return instructions;
        }
        onEvent?.({ type: "tool", name, phase: "start" });
        const result = await executeTool(name, args, rag.embRef, toolCtx);
        onEvent?.({ type: "tool", name, phase: "done" });
        return result;
    };

    const model = rag.chat.provider.kind === "gemini" ? rag.chat.model.id : MODEL;

    onEvent?.({ type: "status", message: "Planning…" });
    const reply = await runGeminiLoop({
        model,
        systemPrompt: `${AGENT_SYSTEM}\n\nSKILLS — proven playbooks for common task types. When one fits, call use_skill(skill_id) to load its full steps before you carry out that work:\n${buildSkillIndex()}\n\n${rag.contextBlock}`,
        userMessage: message,
        toolDeclarations: geminiDeclarationsFor([...MCP_TOOLS, WEB_SEARCH_TOOL, ...ARTIFACT_TOOLS, ...AGENT_TOOLS]),
        dispatch,
        maxRounds: AGENT_CONFIG.maxIterations,
        thinking: rag.allowThinking,
    });

    return { reply, artifacts, steps };
}
