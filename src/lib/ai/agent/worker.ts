// A worker sub-agent: a self-contained mini-agent the lead dispatches for one
// subtask, on whatever model fits (a fast free model for grunt work, Gemini for
// reasoning, etc.). Reuses the existing provider clients so there's no new tooling
// — it just resolves a model and runs the matching path with the shared tool set.
import { MODEL } from "@/lib/gemini";
import { runGeminiLoop } from "@/lib/ai/agent/gemini-loop";
import { AGENT_CONFIG } from "@/lib/ai/agent/config";
import { openaiCompatChat } from "@/lib/ai/openai-compat";
import { executeTool, geminiDeclarationsFor, MCP_TOOLS, WEB_SEARCH_TOOL, type ToolContext } from "@/lib/ai/mcp-service";
import { resolveChatModelByName, resolveChat, type ResolvedChat } from "@/lib/ai/providers";
import type { ResolvedEmbedding } from "@/lib/ai/embeddings";

export interface WorkerParams {
    objective: string;
    modelHint?: string;
    contextBlock: string;
    embRef: ResolvedEmbedding;
    toolCtx: ToolContext;
}

const workerSystem = (contextBlock: string) =>
    `You are a focused worker sub-agent inside a larger task. Complete ONLY the objective you are given, using tools as needed — call search_web for any current or factual information you need. Do NOT create files or documents yourself; return your findings as clear, well-structured text so the lead agent can synthesize them into the single final deliverable. Be efficient and report your result concisely so the lead agent can use it.\n\n${contextBlock}`;

const workerTools = () => geminiDeclarationsFor([...MCP_TOOLS, WEB_SEARCH_TOOL]);

export async function runWorker(p: WorkerParams): Promise<{ model: string; output: string }> {
    // "auto" (no hint) → reliable Gemini Flash. Explicit hints can still route a
    // worker to a fast free model on another provider (with a Gemini fallback).
    const resolved: ResolvedChat =
        (p.modelHint ? resolveChatModelByName(p.modelHint) : null) ?? resolveChat();
    const system = workerSystem(p.contextBlock);

    try {
        if (resolved.provider.kind === "gemini") {
            const output = await runGeminiLoop({
                model: resolved.model.id,
                systemPrompt: system,
                userMessage: p.objective,
                toolDeclarations: workerTools(),
                dispatch: (name, args) => executeTool(name, args, p.embRef, p.toolCtx),
                maxRounds: AGENT_CONFIG.workerMaxRounds,
            });
            return { model: resolved.model.id, output };
        }

        const output = await openaiCompatChat({
            provider: resolved.provider,
            model: resolved.model,
            systemText: system,
            userText: p.objective,
            embRef: p.embRef,
            ctx: p.toolCtx,
        });
        return { model: resolved.model.id, output };
    } catch (err) {
        // A worker's chosen provider can fail (bad key, rate limit, flaky free
        // model) — fall back to the always-available Gemini default rather than
        // letting one subtask sink the whole run.
        console.warn(`[Worker] ${resolved.model.id} failed, falling back to Gemini:`, err);
        const output = await runGeminiLoop({
            systemPrompt: system,
            userMessage: p.objective,
            toolDeclarations: workerTools(),
            dispatch: (name, args) => executeTool(name, args, p.embRef, p.toolCtx),
            maxRounds: AGENT_CONFIG.workerMaxRounds,
        });
        return { model: `${MODEL} (fallback)`, output };
    }
}
