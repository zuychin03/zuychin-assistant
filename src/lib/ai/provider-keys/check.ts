import type { ProviderConfig } from "@/lib/ai/providers";

const CHECK_TIMEOUT_MS = 15_000;
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";

/**
 * A request that fails on a bad key. Public model lists (OpenRouter, Kilo, NIM, OpenCode)
 * answer without one, so those providers use an authenticated endpoint or a 1-token chat.
 */
export type KeyCheck =
    | { kind: "gemini" }
    | { kind: "get"; path: string }
    | { kind: "chat"; model: string };

export const KEY_CHECKS: Readonly<Record<string, KeyCheck>> = {
    gemini: { kind: "gemini" },
    "gemini-free": { kind: "gemini" },
    openrouter: { kind: "get", path: "/key" },
    kilo: { kind: "chat", model: "nvidia/nemotron-3.5-lightning:free" },
    "nvidia-nim": { kind: "chat", model: "nvidia/nemotron-3.5-lightning-30b-a3b" },
    deepseek: { kind: "get", path: "/models" },
    groq: { kind: "get", path: "/models" },
    // Paid: about a millionth of a dollar per check at the 19/11/2026 price.
    "opencode-zen": { kind: "chat", model: "glm-5.3-flash" },
};

export interface KeyCheckResult {
    outcome: "ok" | "rejected" | "unknown";
    status: number | null;
    ms: number;
    message: string;
}

function rejectedByGemini(status: number, body: string): boolean {
    return status === 400 && /API_KEY_INVALID|API key not valid/i.test(body);
}

function describe(outcome: KeyCheckResult["outcome"], status: number | null, ms: number): string {
    if (outcome === "ok") return `Key works (HTTP ${status}, ${ms} ms).`;
    if (outcome === "rejected") return `Key rejected (HTTP ${status}).`;
    return status === null ? "Could not reach the provider to check the key." : `Could not confirm the key (HTTP ${status}).`;
}

/** Sends one cheap authenticated request. Never logs or returns the key or the response body. */
export async function checkProviderKey(
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">,
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
): Promise<KeyCheckResult> {
    const check = KEY_CHECKS[provider.id];
    const started = Date.now();
    const finish = (outcome: KeyCheckResult["outcome"], status: number | null): KeyCheckResult => {
        const ms = Date.now() - started;
        return { outcome, status, ms, message: describe(outcome, status, ms) };
    };
    if (!check) return { outcome: "unknown", status: null, ms: 0, message: "This provider has no key check." };
    if (check.kind !== "gemini" && !provider.baseUrl) return { outcome: "unknown", status: null, ms: 0, message: "This provider has no base URL." };
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    try {
        let response: Response;
        if (check.kind === "gemini") {
            response = await fetchImpl(GEMINI_MODELS_URL, { headers: { "x-goog-api-key": apiKey }, signal, cache: "no-store" });
        } else if (check.kind === "get") {
            response = await fetchImpl(`${provider.baseUrl}${check.path}`, { headers: { Authorization: `Bearer ${apiKey}`, ...provider.extraHeaders }, signal, cache: "no-store" });
        } else {
            response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...provider.extraHeaders },
                body: JSON.stringify({ model: check.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false }),
                signal, cache: "no-store",
            });
        }
        const body = await response.text().catch(() => "");
        if (response.ok) return finish("ok", response.status);
        if (response.status === 401 || response.status === 403 || (check.kind === "gemini" && rejectedByGemini(response.status, body))) return finish("rejected", response.status);
        return finish("unknown", response.status);
    } catch {
        return finish("unknown", null);
    }
}
