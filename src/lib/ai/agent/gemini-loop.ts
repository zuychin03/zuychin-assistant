import { ai, MODEL } from "@/lib/gemini";
import { ThinkingLevel } from "@google/genai";
import type { GeminiToolDeclarations } from "@/lib/ai/mcp-service";

export interface GeminiLoopOpts {
    model?: string;
    systemPrompt: string;
    userMessage: string;
    toolDeclarations: GeminiToolDeclarations;
    dispatch: (name: string, args: Record<string, unknown>) => Promise<string>;
    maxRounds: number;
    thinking?: boolean;
}

export async function runGeminiLoop(opts: GeminiLoopOpts): Promise<string> {
    const model = opts.model ?? MODEL;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: any[] = [
        { role: "user", parts: [{ text: `${opts.systemPrompt}\n\n## Task\n${opts.userMessage}` }] },
    ];
    const config = {
        tools: [{ functionDeclarations: opts.toolDeclarations }],
        thinkingConfig: { thinkingLevel: opts.thinking ? ThinkingLevel.HIGH : ThinkingLevel.LOW },
    };

    let response = await ai.models.generateContent({ model, contents, config });

    for (let round = 0; round < opts.maxRounds; round++) {
        const calls = response.functionCalls;
        if (!calls || calls.length === 0) break;

        const results = await Promise.all(
            calls.map(async (fc) => {
                const result = await opts.dispatch(fc.name!, (fc.args ?? {}) as Record<string, unknown>);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

        response = await ai.models.generateContent({ model, contents, config });
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
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    id: (fc as any).id,
                },
            })),
        });
        response = await ai.models.generateContent({
            model,
            contents,
            config: { thinkingConfig: config.thinkingConfig },
        });
    }

    return response.text?.trim()
        || "I ran out of steps before finishing this task. Say 'continue' and I'll pick up where I left off.";
}
