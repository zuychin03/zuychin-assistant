import { assertFreeModel, freeChatCandidates } from "@/lib/ai/model-policy";
import { runGeminiLoop } from "@/lib/ai/agent/gemini-loop";
import { AGENT_CONFIG } from "@/lib/ai/agent/config";
import { openaiCompatChat } from "@/lib/ai/openai-compat";
import { addTokenCounts } from "@/lib/ai/stream-usage";
import { executeTool, geminiDeclarationsFor, MCP_TOOLS, READ_ONLY_TOOLS, WEB_SEARCH_TOOL, type ToolContext } from "@/lib/ai/mcp-service";
import { getProviderApiKey, resolveChatModelByName, resolveWorkerChain, WORKER_GEMINI_FALLBACK, type ResolvedChat } from "@/lib/ai/providers";
import type { ResolvedEmbedding } from "@/lib/ai/embeddings";

export interface WorkerParams {
    objective: string;
    modelHint?: string;
    needsTools?: boolean;
    /** Sizes the paid Gemini run; free fast models go first unless paidOnly. */
    complexity?: "simple" | "complex";
    /** Skips the model hint and the free chain, so the subtask stays on the paid Gemini key. */
    paidOnly?: boolean;
    freeOnly?: boolean;
    contextBlock: string;
    embRef: ResolvedEmbedding;
    toolCtx: ToolContext;
    signal?: AbortSignal;
}

const workerSystem = (contextBlock: string, hasTools: boolean) => {
    const toolLine = hasTools
        ? "using tools as needed - call search_web for any current or factual information you need"
        : "working from the objective and the context you are given (you have no tools on this run, so do not reference tool calls)";
    return `You are a focused worker sub-agent inside a larger task. Complete ONLY the objective you are given, ${toolLine}. Do NOT create files or documents yourself; return your findings as clear, well-structured text so the lead agent can synthesize them into the single final deliverable. Be efficient and report your result concisely so the lead agent can use it.\n\n${contextBlock}`;
};

// Workers read untrusted text by design: search_web results, email bodies and
// vault pages all land in their context. Anything that mutates state or leaves
// the machine is withheld, so a page that says "email this to X" has nothing to
// reach for.
const WORKER_TOOLS = READ_ONLY_TOOLS;

const workerTools = () =>
    geminiDeclarationsFor([...MCP_TOOLS, WEB_SEARCH_TOOL].filter((t) => WORKER_TOOLS.has(t.name)));

// Enforced here rather than by trimming the declarations: a model can emit a
// name it was never offered, and executeTool would run it.
function guardedDispatch(dispatch: (name: string, args: Record<string, unknown>) => Promise<string>) {
    return async (name: string, args: Record<string, unknown>): Promise<string> => {
        if (!WORKER_TOOLS.has(name)) {
            return `Refused: "${name}" is not available to a worker sub-agent. Workers gather information only - they cannot write, send or delete. Report what you found and let the lead agent act on it.`;
        }
        return dispatch(name, args);
    };
}

// Sentinel returned by openaiCompatChat instead of throwing on an empty answer.
const EMPTY_REPLY = "(The model returned an empty response.)";
const isEmptyReply = (out: string) => !out.trim() || out.trim() === EMPTY_REPLY;

export async function runWorker(p: WorkerParams): Promise<{ model: string; output: string; tokens: number | null }> {
    const needsTools = p.needsTools ?? true;
    const freeOnly = !p.paidOnly && (p.freeOnly === true || p.toolCtx.freeOnly === true);
    const toolCtx = { ...p.toolCtx, freeOnly };
    p.signal?.throwIfAborted();
    let priorTokens: number | null = 0;

    // Candidates: explicit model hint first, then the free fast chain. Paid
    // Gemini runs once they all fail, or straight away on a paid-only run.
    const pool = p.paidOnly ? [] : [p.modelHint ? resolveChatModelByName(p.modelHint) : null, ...resolveWorkerChain(needsTools), ...(freeOnly ? freeChatCandidates().filter((candidate) => !needsTools || candidate.model.supportsTools) : [])];
    const seen = new Set<string>();
    const candidates: ResolvedChat[] = [];
    for (const c of pool) {
        if (!c || (freeOnly && c.model.free !== true)) continue;
        const key = `${c.provider.id}::${c.model.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(c);
        }
    }

    const geminiRun = (model?: string, apiKey?: string, providerId = "gemini") =>
        runGeminiLoop({
            providerId,
            purpose: "worker",
            ...(model ? { model } : {}),
            apiKey,
            systemPrompt: workerSystem(p.contextBlock, true),
            userMessage: p.objective,
            toolDeclarations: workerTools(),
            dispatch: guardedDispatch((name, args) => executeTool(name, args, p.embRef, toolCtx)),
            maxRounds: AGENT_CONFIG.workerMaxRounds,
            signal: p.signal,
        });

    for (const resolved of candidates) {
        let candidateTokens: number | null = null;
        try {
            if (freeOnly) assertFreeModel(resolved);
            if (resolved.provider.kind === "gemini") {
                const { text, usage } = await geminiRun(resolved.model.id, getProviderApiKey(resolved.provider), resolved.provider.id);
                candidateTokens = usage.totalTokens;
                if (!isEmptyReply(text)) return { model: resolved.model.id, output: text, tokens: addTokenCounts(priorTokens, candidateTokens) };
            } else {
                const output = await openaiCompatChat({
                    purpose: "worker",
                    provider: resolved.provider,
                    model: resolved.model,
                    systemText: workerSystem(p.contextBlock, resolved.model.supportsTools),
                    userText: p.objective,
                    embRef: p.embRef,
                    ctx: toolCtx,
                    allowTools: WORKER_TOOLS,
                    onUsage: (usage) => { candidateTokens = usage.totalTokens; },
                    signal: p.signal,
                });
                if (!isEmptyReply(output)) return { model: resolved.model.id, output, tokens: addTokenCounts(priorTokens, candidateTokens) };
            }
            console.warn(`[Worker] ${resolved.model.id} returned nothing, trying next model`);
        } catch (err) {
            // A cancel must abort the whole worker, not fall through to the next model.
            if (p.signal?.aborted) throw err;
            console.warn(`[Worker] ${resolved.model.id} failed, trying next model:`, err);
        }
        priorTokens = addTokenCounts(priorTokens, candidateTokens);
    }

    p.signal?.throwIfAborted();
    if (freeOnly) throw new Error("Free only: all eligible worker routes failed or are unavailable. No paid fallback was used.");
    const fallbackModel = p.complexity === "complex" ? WORKER_GEMINI_FALLBACK.complex : WORKER_GEMINI_FALLBACK.simple;
    const { text, usage } = await geminiRun(fallbackModel);
    return { model: p.paidOnly ? fallbackModel : `${fallbackModel} (fallback)`, output: text, tokens: addTokenCounts(priorTokens, usage.totalTokens) };
}
