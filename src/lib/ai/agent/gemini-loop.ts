import { ai, MODEL } from "@/lib/gemini";
import { ThinkingLevel } from "@google/genai";
import type { GeminiToolDeclarations } from "@/lib/ai/mcp-service";
import { AGENT_CONFIG } from "@/lib/ai/agent/config";

export interface LoopUsage {
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
    llmCalls: number;
}

export interface GeminiLoopOpts {
    model?: string;
    systemPrompt: string;
    userMessage: string;
    toolDeclarations: GeminiToolDeclarations;
    dispatch: (name: string, args: Record<string, unknown>) => Promise<string>;
    maxRounds: number;
    thinking?: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function summarizeText(contents: any[]): string {
    return contents
        .map((c) => {
            const parts = Array.isArray(c?.parts) ? c.parts : [];
            return parts
                .map((p: any) => {
                    if (p.text) return p.text;
                    if (p.functionCall) return `[called ${p.functionCall.name}(${JSON.stringify(p.functionCall.args ?? {})})]`;
                    if (p.functionResponse) {
                        const result = String(p.functionResponse.response?.result ?? "");
                        return `[${p.functionResponse.name} returned]\n${result}`;
                    }
                    return "";
                })
                .join("\n");
        })
        .join("\n\n");
}

// Replaces the middle of the transcript with one condensed turn once the
// context grows past the threshold. contents is [task, (model, fnResponse)*],
// so cutting a multiple of 2 from the end keeps functionCall/functionResponse
// pairs intact — never separate them or the API rejects the transcript.
async function compactContents(contents: any[], model: string): Promise<any[]> {
    const keepTail = AGENT_CONFIG.compactionKeepPairs * 2;
    if (contents.length < keepTail + 3) return contents;

    const head = contents[0];
    const middle = contents.slice(1, contents.length - keepTail);
    const tail = contents.slice(contents.length - keepTail);

    let condensed: string;
    try {
        const response = await ai.models.generateContent({
            model,
            contents: [{
                role: "user",
                parts: [{
                    text: `Condense this agent work log into the key findings, decisions, tool results worth remembering, and remaining open items. Be thorough on facts, terse on narration.\n\n${summarizeText(middle).slice(0, 400_000)}`,
                }],
            }],
            config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
        });
        condensed = response.text?.trim() || "";
    } catch (e) {
        console.warn("[AgentLoop] Compaction summary failed, truncating instead:", e);
        condensed = "";
    }

    if (!condensed) {
        // Truncate long tool results in place rather than losing the turns.
        for (const c of middle) {
            for (const p of Array.isArray(c?.parts) ? c.parts : []) {
                const result = p.functionResponse?.response?.result;
                if (typeof result === "string" && result.length > 500) {
                    p.functionResponse.response.result = result.slice(0, 500) + "\n[truncated]";
                }
            }
        }
        return [head, ...middle, ...tail];
    }

    return [
        head,
        { role: "model", parts: [{ text: "(earlier work omitted)" }] },
        { role: "user", parts: [{ text: `[Earlier progress condensed]\n${condensed}` }] },
        ...tail,
    ];
}

export async function runGeminiLoop(opts: GeminiLoopOpts): Promise<{ text: string; usage: LoopUsage }> {
    const model = opts.model ?? MODEL;
    let contents: any[] = [
        { role: "user", parts: [{ text: `${opts.systemPrompt}\n\n## Task\n${opts.userMessage}` }] },
    ];
    const config = {
        tools: [{ functionDeclarations: opts.toolDeclarations }],
        thinkingConfig: { thinkingLevel: opts.thinking ? ThinkingLevel.HIGH : ThinkingLevel.LOW },
    };

    const usage: LoopUsage = { promptTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0 };
    let lastPromptTokens = 0;
    const trackUsage = (response: any) => {
        usage.llmCalls++;
        const meta = response.usageMetadata;
        if (!meta) return;
        lastPromptTokens = meta.promptTokenCount ?? lastPromptTokens;
        usage.promptTokens += meta.promptTokenCount ?? 0;
        usage.outputTokens += meta.candidatesTokenCount ?? 0;
        usage.totalTokens += meta.totalTokenCount ?? 0;
    };

    let response = await ai.models.generateContent({ model, contents, config });
    trackUsage(response);

    for (let round = 0; round < opts.maxRounds; round++) {
        const calls = response.functionCalls;
        if (!calls || calls.length === 0) break;

        const results = await Promise.all(
            calls.map(async (fc) => {
                const result = await opts.dispatch(fc.name!, (fc.args ?? {}) as Record<string, unknown>);
                return { name: fc.name!, result, id: (fc as any).id };
            })
        );

        contents.push(response.candidates![0].content);
        contents.push({
            role: "user",
            parts: results.map((r) => ({
                functionResponse: { name: r.name, response: { result: r.result }, id: r.id },
            })),
        });

        if (
            lastPromptTokens > AGENT_CONFIG.compactionTokenThreshold ||
            JSON.stringify(contents).length > AGENT_CONFIG.compactionCharFallback
        ) {
            contents = await compactContents(contents, model);
            lastPromptTokens = 0;
        }

        response = await ai.models.generateContent({ model, contents, config });
        trackUsage(response);
    }

    // If the round budget runs out with calls still pending, response.text is
    // empty or mid-work narration. Answer the calls with a stop notice and
    // force one final tool-free turn instead.
    if (response.functionCalls && response.functionCalls.length > 0) {
        contents.push(response.candidates![0].content);
        contents.push({
            role: "user",
            parts: response.functionCalls.map((fc) => ({
                functionResponse: {
                    name: fc.name!,
                    response: { result: "Iteration budget exhausted. Stop working. Summarize exactly what you completed and what remains, and suggest the user say 'continue' to finish the rest." },
                    id: (fc as any).id,
                },
            })),
        });
        response = await ai.models.generateContent({
            model,
            contents,
            config: { thinkingConfig: config.thinkingConfig },
        });
        trackUsage(response);
    }

    const text = response.text?.trim()
        || "I ran out of steps before finishing this task. Say 'continue' and I'll pick up where I left off.";
    return { text, usage };
}
