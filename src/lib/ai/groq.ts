// Groq request quirks, from its docs on 19/11/2026.

/** gpt-oss always reasons, so "off" means low effort with the reasoning dropped; Qwen 3.8 has a real off switch. */
export function groqReasoning(modelId: string, thinking: boolean): Record<string, unknown> {
    if (modelId.startsWith("openai/gpt-oss")) return thinking ? { reasoning_effort: "high" } : { reasoning_effort: "low", include_reasoning: false };
    if (modelId.startsWith("qwen/")) return thinking ? { reasoning_effort: "default", reasoning_format: "parsed" } : { reasoning_effort: "none" };
    return {};
}

/** Groq answers HTTP 400 to `messages[].name` and has deprecated `max_tokens` for `max_completion_tokens`. */
export function groqBody(body: Record<string, unknown>, modelId: string, thinking: boolean): Record<string, unknown> {
    const { max_tokens: maxTokens, ...rest } = body;
    const messages = Array.isArray(rest.messages)
        ? rest.messages.map((message) => {
            if (!message || typeof message !== "object") return message;
            const kept = { ...(message as Record<string, unknown>) };
            delete kept.name;
            return kept;
        })
        : rest.messages;
    return { ...rest, messages, ...(maxTokens !== undefined ? { max_completion_tokens: maxTokens } : {}), ...groqReasoning(modelId, thinking) };
}
