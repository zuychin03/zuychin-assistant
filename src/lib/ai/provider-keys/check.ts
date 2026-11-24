import { providerAccountId, splitAccountKey, type ProviderConfig } from "@/lib/ai/providers";

const CHECK_TIMEOUT_MS = 15_000;
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * A request that fails on a bad key. Public model lists (OpenRouter, Kilo, NIM, OpenCode)
 * answer without one, so those providers use an authenticated endpoint or a 1-token chat.
 */
export type KeyCheck =
    | { kind: "gemini" }
    | { kind: "get"; path: string }
    | { kind: "chat"; model: string }
    | { kind: "cloudflare" };

export const KEY_CHECKS: Readonly<Record<string, KeyCheck>> = {
    gemini: { kind: "gemini" },
    "gemini-free": { kind: "gemini" },
    openrouter: { kind: "get", path: "/key" },
    kilo: { kind: "chat", model: "nvidia/nemotron-3.5-lightning:free" },
    "nvidia-nim": { kind: "chat", model: "nvidia/nemotron-3.5-lightning-30b-a3b" },
    deepseek: { kind: "get", path: "/models" },
    groq: { kind: "get", path: "/models" },
    agnes: { kind: "get", path: "/models" },
    // Paid: about a millionth of a dollar per check at the 19/11/2026 price.
    "opencode-zen": { kind: "chat", model: "glm-5.3-flash" },
    // Token verify, then a call under the account id, so a wrong id is caught too. Neither spends neurons.
    cloudflare: { kind: "cloudflare" },
    llamaparse: { kind: "get", path: "/api/v1/projects" },
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

/** `key` may be `<account id>:<token>`; without the id it comes from the saved key or the env var. */
async function checkCloudflare(provider: Pick<ProviderConfig, "id" | "accountIdEnv">, key: string, fetchImpl: typeof fetch): Promise<KeyCheckResult> {
    const started = Date.now();
    const { accountId: given, apiKey: token } = splitAccountKey(key);
    const accountId = given ?? providerAccountId(provider);
    const result = (outcome: KeyCheckResult["outcome"], status: number | null, message: string): KeyCheckResult => ({ outcome, status, ms: Date.now() - started, message });
    if (!accountId) return result("unknown", null, "No account id. Add the 32-character account id next to the token.");
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    const headers = { Authorization: `Bearer ${token}` };
    try {
        const verify = await fetchImpl(`${CLOUDFLARE_API}/user/tokens/verify`, { headers, signal, cache: "no-store" });
        await verify.text().catch(() => "");
        // A malformed token answers 400, an unknown one 401.
        if ([400, 401, 403].includes(verify.status)) return result("rejected", verify.status, `Token rejected (HTTP ${verify.status}).`);
        if (!verify.ok) return result("unknown", verify.status, `Could not confirm the token (HTTP ${verify.status}).`);
        const account = await fetchImpl(`${CLOUDFLARE_API}/accounts/${accountId}/ai/models/search?per_page=1`, { headers, signal, cache: "no-store" });
        await account.text().catch(() => "");
        if ([403, 404].includes(account.status)) return result("rejected", account.status, `The token works, but not on that account id (HTTP ${account.status}).`);
        if (!account.ok) return result("unknown", account.status, `Could not confirm the account id (HTTP ${account.status}).`);
        return result("ok", account.status, `Token and account id work (HTTP ${account.status}, ${Date.now() - started} ms).`);
    } catch {
        return result("unknown", null, "Could not reach the provider to check the key.");
    }
}

/** Sends one cheap authenticated request. Never logs or returns the key or the response body. */
export async function checkProviderKey(
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders" | "accountIdEnv">,
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
    if (check.kind === "cloudflare") return checkCloudflare(provider, apiKey, fetchImpl);
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
