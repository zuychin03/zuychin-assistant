import { ThinkingLevel } from "@google/genai";
import { geminiClient } from "@/lib/gemini";
import { cappedMaxTokens, getProviderApiKey, resolveMessagingEmbedding, type ResolvedChat } from "@/lib/ai/providers";
import { classifyModelError, collectModelObservations, configureModelDataPolicy, observeGeminiClient } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import type { ModelDataClass } from "@/lib/ai/data-policy";
import { openaiCompatChat } from "@/lib/ai/openai-compat";
import { REASONING_HEADROOM_TOKENS, SEAT_CALL_TIMEOUT_MS } from "./limits";

export type SeatCallResult =
    | { ok: true; text: string; ms: number }
    | { ok: false; error: string; ms: number; retryable: boolean };

export type SeatCaller = (params: {
    resolved: ResolvedChat; system: string; user: string; maxTokens: number; freeOnly: boolean; signal?: AbortSignal;
    /** Set when the prompt carries research sources; plain calls are personal only. */
    classes?: ModelDataClass[];
}) => Promise<SeatCallResult>;

let storageWarned = false;

async function generate(resolved: ResolvedChat, system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<string> {
    const tokens = cappedMaxTokens(maxTokens + REASONING_HEADROOM_TOKENS, resolved.model.id);
    if (resolved.provider.kind === "gemini") {
        const client = observeGeminiClient(geminiClient(getProviderApiKey(resolved.provider)), { providerId: resolved.provider.id, purpose: "council" });
        const response = await client.models.generateContent({
            model: resolved.model.id,
            contents: [{ role: "user", parts: [{ text: user }] }],
            config: { systemInstruction: system, maxOutputTokens: tokens, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, abortSignal: signal },
        });
        return response.text ?? "";
    }
    return openaiCompatChat({
        purpose: "council",
        provider: resolved.provider,
        // No tools at all: a seat reads untrusted text from other models.
        model: { ...resolved.model, supportsTools: false },
        systemText: system,
        userText: user,
        embRef: resolveMessagingEmbedding(),
        genParams: { maxTokens: tokens },
        signal,
    });
}

/** One text-only council call, recorded in model health under purpose "council". */
export const callSeatModel: SeatCaller = async ({ resolved, system, user, maxTokens, freeOnly, signal, classes }) => {
    const started = Date.now();
    const timeout = AbortSignal.timeout(SEAT_CALL_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let observations: Awaited<ReturnType<typeof collectModelObservations>>["observations"] = [];
    try {
        const collected = await collectModelObservations(async () => {
            configureModelDataPolicy(freeOnly);
            return generate(resolved, system, user, maxTokens, combined);
        }, classes ?? ["personal"]);
        observations = collected.observations;
        const text = collected.value.trim();
        if (!text) return { ok: false, error: "empty reply", ms: Date.now() - started, retryable: true };
        return { ok: true, text, ms: Date.now() - started };
    } catch (error) {
        const { status } = classifyModelError(error);
        const timedOut = timeout.aborted && !signal?.aborted;
        const message = timedOut ? `no reply within ${Math.round(SEAT_CALL_TIMEOUT_MS / 1000)} s`
            : error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
        return { ok: false, error: message, ms: Date.now() - started, retryable: timedOut || status === "rate_limit" || status === "transient" };
    } finally {
        if (observations.length) {
            const stored = await persistModelObservations(observations).catch(() => null);
            if ((!stored || stored.error) && !storageWarned) {
                storageWarned = true;
                console.warn(`[OnlineCouncil] Council calls were not stored in model health (${stored?.error ?? "error"}); the council purpose needs scripts/migrations/v7-online-council.sql.`);
            }
        }
    }
};
