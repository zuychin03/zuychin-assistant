import { ai, MODEL } from "@/lib/gemini";

export type SearchDepth = "quick" | "thorough";

// Tavily meters credits per account, not per key, so each key is an independent
// pool. Each depth gets its own pool by default: heavy research can't drain the
// budget everyday lookups run on. Either depth borrows the other's pool once its
// own is spent, and Gemini grounding catches the case where both are.
interface TavilyPool {
    key: string;
    role: SearchDepth;
    blockedUntil: number;
}

// Tavily answers 432 once the plan's usage limit is hit, and that stays true until
// the quota resets. Park the pool instead of burning a failed round-trip on every
// search. 429 is ordinary rate limiting, so it backs off far more briefly.
const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

const DEPTH_CONFIG: Record<SearchDepth, { searchDepth: string; maxResults: number; rawContent: boolean }> = {
    quick: { searchDepth: "basic", maxResults: 5, rawContent: false },
    thorough: { searchDepth: "advanced", maxResults: 8, rawContent: true },
};

// Raw page text is unbounded; cap it so one result can't crowd out the rest.
const RAW_CONTENT_LIMIT = 1200;

const POOLS: TavilyPool[] = [
    { key: process.env.TAVILY_API_KEY, role: "quick" as const },
    { key: process.env.TAVILY_API_KEY_DEEP, role: "thorough" as const },
]
    .filter((p): p is { key: string; role: SearchDepth } => !!p.key)
    .map((p) => ({ ...p, blockedUntil: 0 }));

function poolsFor(depth: SearchDepth): TavilyPool[] {
    const now = Date.now();
    return [...POOLS]
        .sort((a, b) => Number(b.role === depth) - Number(a.role === depth))
        .filter((p) => now >= p.blockedUntil);
}

interface TavilyResponse {
    answer?: string;
    results?: { title: string; url: string; content: string; raw_content?: string }[];
}

// null means this pool is unusable and the caller should try the next one.
async function searchWithPool(pool: TavilyPool, query: string, depth: SearchDepth): Promise<string | null> {
    const cfg = DEPTH_CONFIG[depth];

    try {
        const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${pool.key}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                query,
                max_results: cfg.maxResults,
                include_answer: true,
                search_depth: cfg.searchDepth,
                include_raw_content: cfg.rawContent,
            }),
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            if (res.status === 432 || res.status === 402) {
                pool.blockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
            } else if (res.status === 429) {
                pool.blockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            }
            console.error(`[WebSearch] Tavily ${res.status} on ${pool.role} pool:`, detail.slice(0, 200));
            return null;
        }

        const data = (await res.json()) as TavilyResponse;
        const results = data.results ?? [];

        if (!data.answer && results.length === 0) {
            return `No web results found for "${query}".`;
        }

        const lines: string[] = [];
        if (data.answer) {
            lines.push(`Summary: ${data.answer}`, "");
        }
        results.forEach((r, i) => {
            const raw = cfg.rawContent && r.raw_content
                ? `\n${r.raw_content.slice(0, RAW_CONTENT_LIMIT)}`
                : "";
            lines.push(`[${i + 1}] ${r.title}\n${r.url}\n${r.content}${raw}`);
        });

        return lines.join("\n");
    } catch (err) {
        console.error(`[WebSearch] Tavily ${pool.role} pool failed:`, err);
        return null;
    }
}

// null means no Tavily pool could serve this; the caller should fall back.
export async function webSearch(query: string, depth: SearchDepth = "quick"): Promise<string | null> {
    for (const pool of poolsFor(depth)) {
        const result = await searchWithPool(pool, query, depth);
        if (result !== null) return result;
    }
    return null;
}

export async function geminiWebSearch(query: string): Promise<string> {
    try {
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts: [{ text: `Search the web and answer with concrete, current facts and figures: ${query}` }] }],
            config: { tools: [{ googleSearch: {} }] },
        });

        const text = (response.text ?? "").trim();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunks = (response.candidates?.[0] as any)?.groundingMetadata?.groundingChunks as { web?: { uri?: string; title?: string } }[] | undefined;
        const sources = (chunks ?? [])
            .map((c) => c.web?.uri)
            .filter((u): u is string => !!u)
            .slice(0, 5);

        if (!text) return `No web results found for "${query}".`;
        const srcText = sources.length
            ? `\n\nSources:\n${sources.map((u, i) => `[${i + 1}] ${u}`).join("\n")}`
            : "";
        return text + srcText;
    } catch (err) {
        console.error("[WebSearch] Gemini grounding failed:", err);
        return "Web search failed, please try again later.";
    }
}

export async function runWebSearch(query: string, depth: SearchDepth = "quick"): Promise<string> {
    return (await webSearch(query, depth)) ?? geminiWebSearch(query);
}
