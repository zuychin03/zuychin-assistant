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
