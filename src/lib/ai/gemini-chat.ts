import type { Candidate, Content, GenerateContentConfig, GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import { appendPiece, CONTINUE_PROMPT, CONTINUATION_BUDGET_MS, MAX_CONTINUATIONS, TRUNCATION_NOTE } from "@/lib/ai/continuation";
import { withModelPurpose } from "@/lib/ai/model-observations";

type StreamClient = { models: { generateContentStream(params: GenerateContentParameters): Promise<AsyncGenerator<GenerateContentResponse>> } };
type TokenSink = (text: string, reset?: boolean) => void;
interface GeminiTurn { text: string; content: Content; candidate: Candidate; truncated: boolean }

export async function streamGeminiTurn(params: {
    client: StreamClient; model: string; contents: Content[]; config: GenerateContentConfig;
    onToken?: TokenSink; signal?: AbortSignal;
}): Promise<GeminiTurn> {
    params.signal?.throwIfAborted();
    const stream = await params.client.models.generateContentStream({
        model: params.model, contents: params.contents,
        config: { ...params.config, ...(params.signal ? { abortSignal: params.signal } : {}) },
    });
    const parts: Part[] = [];
    let text = "";
    let candidate: Candidate = {};
    let finishReason: string | undefined;
    for await (const chunk of stream) {
        params.signal?.throwIfAborted();
        const current = chunk.candidates?.[0];
        if (!current) continue;
        if (current.finishReason) finishReason = String(current.finishReason);
        candidate = { ...candidate, ...current, groundingMetadata: current.groundingMetadata ?? candidate.groundingMetadata };
        for (const part of current.content?.parts ?? []) {
            parts.push(part);
            if (part.text && !part.thought) {
                text += part.text;
                params.onToken?.(part.text);
            }
        }
    }
    params.signal?.throwIfAborted();
    if (!finishReason) throw new Error("The model stream was interrupted before completion. Please retry.");
    if (finishReason !== "STOP" && finishReason !== "MAX_TOKENS") throw new Error(`The model stopped without a complete answer (${finishReason}).`);
    const calls = parts.flatMap((part) => part.functionCall ? [part.functionCall] : []);
    if (calls.length && finishReason !== "STOP") throw new Error("The model returned incomplete tool calls. No pending tool was executed.");
    const ids = new Set<string>();
    for (const call of calls) {
        if (!call.name || (call.args !== undefined && (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)))) {
            throw new Error("The model returned an invalid tool call. No pending tool was executed.");
        }
        if (call.id && ids.has(call.id)) throw new Error("The model returned duplicate tool IDs. No pending tool was executed.");
        if (call.id) ids.add(call.id);
    }
    return { text, content: { role: "model", parts }, candidate, truncated: finishReason === "MAX_TOKENS" };
}

export async function generateGeminiChat(params: {
    client: StreamClient; model: string; contents: Content[];
    initialConfig: GenerateContentConfig; finalConfig: GenerateContentConfig;
    executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    maxToolRounds?: number; signal?: AbortSignal; onToken?: TokenSink;
    cite?: (text: string, candidate: Candidate) => string;
}): Promise<string> {
    const contents = [...params.contents];
    const run = (config: GenerateContentConfig, onToken = params.onToken) => streamGeminiTurn({ ...params, contents, config, onToken });
    let turn = await run(params.initialConfig);
    let round = 0;
    while (turn.content.parts?.some((part) => part.functionCall)) {
        params.signal?.throwIfAborted();
        const exhausted = round >= (params.maxToolRounds ?? 8);
        const results: Part[] = [];
        for (const part of turn.content.parts) {
            const call = part.functionCall;
            if (!call) continue;
            params.signal?.throwIfAborted();
            const result = exhausted
                ? "The tool budget for this reply is exhausted. Explain what completed and what remains. Ask the user to continue if needed."
                : await params.executeTool(call.name!, call.args ?? {});
            params.signal?.throwIfAborted();
            results.push({ functionResponse: { name: call.name!, ...(call.id ? { id: call.id } : {}), response: { result } } });
        }
        contents.push(turn.content, { role: "user", parts: results });
        if (turn.text) params.onToken?.("", true);
        turn = await run(exhausted ? params.finalConfig : params.initialConfig);
        round++;
        if (exhausted && turn.content.parts?.some((part) => part.functionCall)) throw new Error("The model requested tools after the tool budget ended.");
    }
    let answer = params.cite?.(turn.text, turn.candidate) ?? turn.text;
    const started = performance.now();
    for (let attempt = 0; turn.truncated && attempt < MAX_CONTINUATIONS; attempt++) {
        if (performance.now() - started > CONTINUATION_BUDGET_MS) break;
        params.signal?.throwIfAborted();
        contents.push(turn.content, { role: "user", parts: [{ text: CONTINUE_PROMPT }] });
        try {
            turn = await withModelPurpose("continuation", () => run(params.finalConfig, () => {}));
        } catch (error) {
            params.signal?.throwIfAborted();
            if (error instanceof Error && error.name === "AbortError") throw error;
            return answer ? answer + TRUNCATION_NOTE : answer;
        }
        if (turn.content.parts?.some((part) => part.functionCall)) throw new Error("The model requested a tool during a tool-free continuation.");
        const piece = params.cite?.(turn.text, turn.candidate) ?? turn.text;
        if (!piece.trim()) { turn.truncated = true; break; }
        answer = appendPiece(answer, piece).text;
        params.onToken?.(answer, true);
    }
    params.signal?.throwIfAborted();
    if (!answer.trim()) throw new Error("The model returned no answer. Please retry.");
    return turn.truncated ? answer + TRUNCATION_NOTE : answer;
}
