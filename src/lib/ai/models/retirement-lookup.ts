import type { DraftRequest } from "@/lib/ai/models/lookup";

// Weekly check of an in-use non-chat model: NVIDIA's build page first for NIM models, then a search of the provider's
// own docs, keeping a date only when a page states one. Advisory: the result always carries its source link.

export const RETIREMENT_DOMAINS: Readonly<Record<string, readonly string[]>> = {
    "nvidia-nim": ["build.nvidia.com", "docs.api.nvidia.com"],
    gemini: ["ai.google.dev"],
    "gemini-free": ["ai.google.dev"],
    groq: ["console.groq.com"],
    openrouter: ["openrouter.ai"],
};

const SNIPPET_MAX = 1200;
const RESULTS_MAX = 5;
const PAGE_TIMEOUT_MS = 15_000;
const PAGE_MAX_BYTES = 3_000_000;

export type RetirementOutcome = { ok: true; date: string | null; url: string | null } | { ok: false; error: string };

export interface RetirementTarget {
    providerId: string;
    providerLabel: string;
    modelId: string;
    label: string;
}

export interface RetirementLookupDeps {
    search(query: string, domains: readonly string[]): Promise<{ title: string; url: string; content: string }[] | null>;
    ask(request: DraftRequest): Promise<unknown | null>;
    /** A page's HTML, or null when it could not be read. Absent: no build page check. */
    page?(url: string): Promise<string | null>;
}

/** build.nvidia.com/<publisher>/<model>, with the dots in the model name written as underscores. */
export function nimBuildPageUrl(modelId: string): string | null {
    const parts = modelId.split("/");
    if (parts.length !== 2 || !/^[a-z0-9][a-z0-9._-]*$/i.test(parts[0]) || !/^[a-z0-9][a-z0-9._-]*$/i.test(parts[1])) return null;
    return `https://build.nvidia.com/${parts[0]}/${parts[1].replace(/\./g, "_")}`;
}

/**
 * The deprecation date a NIM build page states, as an ISO timestamp. The page carries it as a
 * `"DEPRECATION","value":"11/22/2026"` attribute and in "This API will be deprecated on 11/22/2026" (US day order).
 */
export function buildPageDate(html: string): string | null {
    const match = /DEPRECATION\\?"\s*,\s*\\?"value\\?"\s*:\s*\\?"(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(html)
        ?? /will be deprecated on (\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(html);
    if (!match) return null;
    const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms);
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString() : null;
}

const SCHEMA = {
    type: "object",
    properties: {
        date: { type: ["string", "null"], description: "YYYY-MM-DD, or null" },
        url: { type: ["string", "null"], description: "The result URL that states the date, or null" },
    },
    required: ["date", "url"],
};

/** A plain date, or null for anything else. */
export function lookupDate(value: unknown): string | null {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
    const ms = Date.parse(`${value.trim()}T00:00:00Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export async function lookupRetirement(target: RetirementTarget, deps: RetirementLookupDeps): Promise<RetirementOutcome> {
    const buildPage = target.providerId === "nvidia-nim" && deps.page ? nimBuildPageUrl(target.modelId) : null;
    if (buildPage) {
        const html = await deps.page!(buildPage).catch(() => null);
        // A page that loaded is the answer either way; a failed one falls back to the search.
        if (html !== null) {
            const date = buildPageDate(html);
            return { ok: true, date, url: date ? buildPage : null };
        }
    }
    const domains = RETIREMENT_DOMAINS[target.providerId];
    if (!domains) return { ok: true, date: null, url: null };
    const results = await deps.search(`"${target.modelId}" deprecation OR retirement OR "end of life" OR shutdown`, domains);
    if (results === null) return { ok: false, error: "The web search is unavailable." };
    const shown = results.filter((result) => domains.some((domain) => {
        try { const host = new URL(result.url).hostname; return host === domain || host.endsWith(`.${domain}`); } catch { return false; }
    })).slice(0, RESULTS_MAX);
    if (!shown.length) return { ok: true, date: null, url: null };
    const answer = await deps.ask({
        system: "You read provider documentation search results. Answer only from the text given. Never guess.",
        user: [
            `Model id: ${target.modelId} (${target.label}) on ${target.providerLabel}.`,
            "Does any result state the date this exact model id is or was deprecated, retired, shut down or removed?",
            "Return the date as YYYY-MM-DD and the URL of the result that states it. If no result states a date for this exact model, return null for both.",
            "",
            ...shown.map((result, index) => `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.content.slice(0, SNIPPET_MAX)}`),
        ].join("\n"),
        schema: SCHEMA,
    });
    if (!answer || typeof answer !== "object") return { ok: false, error: "No answer from the lookup model." };
    const { date, url } = answer as { date?: unknown; url?: unknown };
    const parsed = lookupDate(date);
    const source = typeof url === "string" ? shown.find((result) => result.url === url.trim())?.url ?? null : null;
    // A date without one of the given pages behind it is not kept.
    return parsed && source ? { ok: true, date: parsed, url: source } : { ok: true, date: null, url: null };
}

/** Loaded lazily: the search and Gemini modules read keys at import time. */
export function liveRetirementDeps(): RetirementLookupDeps {
    return {
        search: async (query, domains) => {
            const { webSearchResults } = await import("@/lib/ai/web-search");
            const found = await webSearchResults(query, "quick", domains);
            return found ? found.results.map(({ title, url, content }) => ({ title, url, content })) : null;
        },
        ask: async (request) => {
            const { draft } = await import("@/lib/ai/models/lookup-live");
            return (await draft(request))?.json ?? null;
        },
        page: async (url) => {
            try {
                const response = await fetch(url, { headers: { Accept: "text/html", "User-Agent": "zuychin-assistant" }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), cache: "no-store" });
                if (!response.ok) return null;
                const html = await response.text();
                return html.length > PAGE_MAX_BYTES ? html.slice(0, PAGE_MAX_BYTES) : html;
            } catch {
                return null;
            }
        },
    };
}
