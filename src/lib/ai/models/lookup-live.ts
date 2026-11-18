import { ThinkingLevel } from "@google/genai";
import { geminiClient } from "@/lib/gemini";
import { getProvider, getProviderApiKey, isProviderAvailable, type ProviderConfig } from "@/lib/ai/providers";
import { beginModelObservation, observeGeminiClient } from "@/lib/ai/model-observations";
import { requestUsage } from "@/lib/ai/stream-usage";
import { webSearch } from "@/lib/ai/web-search";
import type { CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { modelSpeed, SPEED_WINDOW_DAYS, statsKey, statsSnapshot } from "@/lib/ai/models/stats";
import { auDate, seconds } from "@/lib/ai/models/view";
import { LOOKUP_SOURCE_TIMEOUT_MS, type DraftRequest, type LookupDeps, type LookupTarget } from "@/lib/ai/models/lookup";

const MAX_BYTES = 2_000_000;
const OPENROUTER_LIST = "https://openrouter.ai/api/v1/models";
const LIST_TTL_MS = 60 * 60_000;
// Free routes only. Paid web grounding is never used for a lookup. The free Gemini keys often return 503 under load,
// and NIM Ultra took 29 to 45+ s for a draft in testing on 19/11/2026, so it goes last with the longest wait.
export const LOOKUP_DRAFT_CHAIN = [
    { providerId: "gemini-free", modelId: "gemini-3.8-flash", timeoutMs: 45_000 },
    { providerId: "gemini-free", modelId: "gemini-3.5-flash-lite", timeoutMs: 30_000 },
    { providerId: "nvidia-nim", modelId: "nvidia/nemotron-3-ultra-550b-a55b", timeoutMs: 90_000 },
] as const;

let openRouterCache: { at: number; value: unknown } | null = null;

async function fetchBody(url: string, accept: string): Promise<string | null> {
    const response = await fetch(url, { headers: { Accept: accept, "User-Agent": "model-lookup/1.0" }, redirect: "follow", signal: AbortSignal.timeout(LOOKUP_SOURCE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
    const body = await response.text();
    return body.length > MAX_BYTES ? null : body;
}

async function fetchJson(url: string): Promise<unknown | null> {
    if (url === OPENROUTER_LIST && openRouterCache && Date.now() - openRouterCache.at < LIST_TTL_MS) return openRouterCache.value;
    const body = await fetchBody(url, "application/json").catch(() => null);
    if (!body) return null;
    try {
        const value: unknown = JSON.parse(body);
        if (url === OPENROUTER_LIST) openRouterCache = { at: Date.now(), value };
        return value;
    } catch {
        return null;
    }
}

async function draftWithGemini(provider: ProviderConfig, modelId: string, request: DraftRequest, timeoutMs: number): Promise<unknown | null> {
    const client = observeGeminiClient(geminiClient(getProviderApiKey(provider)), { providerId: provider.id, purpose: "lookup" });
    const response = await client.models.generateContent({
        model: modelId,
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        config: {
            systemInstruction: request.system,
            responseMimeType: "application/json",
            responseJsonSchema: request.schema,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            maxOutputTokens: 4096,
            abortSignal: AbortSignal.timeout(timeoutMs),
        },
    });
    return response.text ? JSON.parse(response.text) as unknown : null;
}

async function draftWithCompat(provider: ProviderConfig, modelId: string, request: DraftRequest, timeoutMs: number): Promise<unknown | null> {
    const observation = beginModelObservation({ providerId: provider.id, modelId, purpose: "lookup" });
    try {
        const response = await fetch(`${provider.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${getProviderApiKey(provider)}`, "Content-Type": "application/json", ...(provider.extraHeaders ?? {}) },
            body: JSON.stringify({
                model: modelId, temperature: 0.2, max_tokens: 4096, stream: false,
                messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
                response_format: { type: "json_schema", json_schema: { name: "model_profile", schema: request.schema } },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            observation.finish({ error: Object.assign(new Error(`HTTP ${response.status}`), { status: response.status }) });
            return null;
        }
        const body = await response.json() as { choices?: { message?: { content?: unknown } }[]; usage?: unknown };
        observation.firstAnswer();
        observation.finish({ usage: requestUsage(body.usage, true) });
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string") return null;
        const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        return JSON.parse(trimmed) as unknown;
    } catch (error) {
        observation.finish({ error });
        return null;
    }
}

async function draft(request: DraftRequest): Promise<{ json: unknown; model: string } | null> {
    for (const step of LOOKUP_DRAFT_CHAIN) {
        const provider = getProvider(step.providerId);
        if (!provider || !isProviderAvailable(provider)) continue;
        try {
            const json = provider.kind === "gemini" ? await draftWithGemini(provider, step.modelId, request, step.timeoutMs) : await draftWithCompat(provider, step.modelId, request, step.timeoutMs);
            if (json && typeof json === "object") return { json, model: `${provider.label} ${step.modelId}` };
        } catch (error) {
            console.warn(`[ModelLookup] ${step.providerId} draft failed:`, error instanceof Error ? error.message : error);
        }
    }
    return null;
}

export function liveLookupDeps(): LookupDeps {
    return {
        fetchJson,
        fetchText: (url) => fetchBody(url, "text/plain, text/markdown").catch(() => null),
        search: (query) => webSearch(query, "quick"),
        draft,
    };
}

/** Our probe results and recorded speed as plain lines for the drafting prompt. */
export function lookupMeasurements(row: CatalogueRow): string[] {
    const lines: string[] = [];
    if (row.probedAt) {
        const yes = (value: boolean | null) => value === null ? "not checked" : value ? "worked" : "failed";
        lines.push(`Test on ${auDate(row.probedAt)}: ${row.probeStatus}${row.probeChatMs !== null ? `, first answer in ${seconds(row.probeChatMs)}` : ""}; tool calls ${yes(row.supportsTools)}; forced tool calls ${yes(row.supportsSearch)}; image test ${yes(row.supportsVision)}.`);
    }
    const speed = modelSpeed(statsSnapshot().speed.get(statsKey(row.providerId, row.modelId)), null);
    if (speed.source === "calls" && speed.firstAnswerMs !== null) {
        lines.push(`Recorded calls over ${SPEED_WINDOW_DAYS} days: median first answer ${seconds(speed.firstAnswerMs)} over ${speed.samples} calls${speed.successRate !== null ? `, ${Math.round(speed.successRate * 100)}% succeeded` : ""}.`);
    }
    if (row.mayTrain) lines.push("The provider says requests on this route may be used for training.");
    return lines;
}

export function lookupTarget(provider: ProviderConfig, row: CatalogueRow): LookupTarget {
    const code = provider.chatModels.find((model) => model.id === row.modelId);
    return {
        providerId: provider.id, providerLabel: provider.label, row,
        caps: { supportsTools: code?.supportsTools ?? row.supportsTools === true, supportsVision: code?.supportsVision ?? row.supportsVision === true },
        measurements: lookupMeasurements(row),
    };
}
