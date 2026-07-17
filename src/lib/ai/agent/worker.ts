import { runGeminiLoop } from "@/lib/ai/agent/gemini-loop";
import { AGENT_CONFIG } from "@/lib/ai/agent/config";
import { openaiCompatChat } from "@/lib/ai/openai-compat";
import { executeTool, geminiDeclarationsFor, MCP_TOOLS, WEB_SEARCH_TOOL, type ToolContext } from "@/lib/ai/mcp-service";
import { resolveChatModelByName, resolveWorkerChain, WORKER_GEMINI_FALLBACK, type ResolvedChat } from "@/lib/ai/providers";
import type { ResolvedEmbedding } from "@/lib/ai/embeddings";

export interface WorkerParams {
    objective: string;
    modelHint?: string;
    needsTools?: boolean;
    /** Sizes the paid Gemini fallback only; free fast models always run first. */
    complexity?: "simple" | "complex";
    contextBlock: string;
    embRef: ResolvedEmbedding;
    toolCtx: ToolContext;
    signal?: AbortSignal;
}

const workerSystem = (contextBlock: string, hasTools: boolean) => {
    const toolLine = hasTools
        ? "using tools as needed — call search_web for any current or factual information you need"
        : "working from the objective and the context you are given (you have no tools on this run, so do not reference tool calls)";
    return `You are a focused worker sub-agent inside a larger task. Complete ONLY the objective you are given, ${toolLine}. Do NOT create files or documents yourself; return your findings as clear, well-structured text so the lead agent can synthesize them into the single final deliverable. Be efficient and report your result concisely so the lead agent can use it.\n\n${contextBlock}`;
};

const workerTools = () => geminiDeclarationsFor([...MCP_TOOLS, WEB_SEARCH_TOOL]);

// Sentinel returned by openaiCompatChat instead of throwing on an empty answer.
const EMPTY_REPLY = "(The model returned an empty response.)";
const isEmptyReply = (out: string) => !out.trim() || out.trim() === EMPTY_REPLY;

export async function runWorker(p: WorkerParams): Promise<{ model: string; output: string; tokens: number }> {
    const needsTools = p.needsTools ?? true;

    // Candidates: explicit model hint first, then the free fast chain.
    // Gemini runs only when all candidates error or return nothing.
    const hinted = p.modelHint ? resolveChatModelByName(p.modelHint) : null;
    const seen = new Set<string>();
    const candidates: ResolvedChat[] = [];
    for (const c of [hinted, ...resolveWorkerChain(needsTools)]) {
        if (!c) continue;
        const key = `${c.provider.id}::${c.model.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(c);
        }
    }

    const geminiRun = (model?: string) =>
        runGeminiLoop({
            ...(model ? { model } : {}),
            systemPrompt: workerSystem(p.contextBlock, true),
            userMessage: p.objective,
            toolDeclarations: workerTools(),
            dispatch: (name, args) => executeTool(name, args, p.embRef, p.toolCtx),
            maxRounds: AGENT_CONFIG.workerMaxRounds,
            signal: p.signal,
        });

    for (const resolved of candidates) {
        try {
            if (resolved.provider.kind === "gemini") {
                const { text, usage } = await geminiRun(resolved.model.id);
                if (!isEmptyReply(text)) return { model: resolved.model.id, output: text, tokens: usage.totalTokens };
            } else {
                let compatTokens = 0;
                const output = await openaiCompatChat({
                    provider: resolved.provider,
                    model: resolved.model,
                    systemText: workerSystem(p.contextBlock, resolved.model.supportsTools),
                    userText: p.objective,
                    embRef: p.embRef,
                    ctx: p.toolCtx,
                    onUsage: (u) => { compatTokens = u.totalTokens; },
                    signal: p.signal,
                });
                if (!isEmptyReply(output)) return { model: resolved.model.id, output, tokens: compatTokens };
            }
            console.warn(`[Worker] ${resolved.model.id} returned nothing, trying next model`);
        } catch (err) {
            // A cancel must abort the whole worker, not fall through to the next model.
            if (p.signal?.aborted) throw err;
            console.warn(`[Worker] ${resolved.model.id} failed, trying next model:`, err);
        }
    }

    p.signal?.throwIfAborted();
    // Paid last resort, sized to the subtask: 3-flash for simple work,
    // 3.5-flash where weak reasoning would just waste the retry.
    const fallbackModel = p.complexity === "complex" ? WORKER_GEMINI_FALLBACK.complex : WORKER_GEMINI_FALLBACK.simple;
    const { text, usage } = await geminiRun(fallbackModel);
    return { model: `${fallbackModel} (fallback)`, output: text, tokens: usage.totalTokens };
}
