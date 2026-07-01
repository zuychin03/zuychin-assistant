// Web search for models that have no built-in internet access. Primary path is
// Tavily; if it isn't configured we fall back to a Gemini Google-Search-grounded
// lookup so the agent still gets real web results with just the Gemini key.

import { ai, MODEL } from "@/lib/gemini";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

export function isWebSearchConfigured(): boolean {
    return !!TAVILY_API_KEY;
}

interface TavilyResponse {
    answer?: string;
    results?: { title: string; url: string; content: string }[];
}

// Run a search and return the results as plain text for the model to read.
export async function webSearch(query: string, maxResults = 5): Promise<string> {
    if (!TAVILY_API_KEY) {
        return "Web search isn't set up on this server (no TAVILY_API_KEY).";
    }

    try {
        const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TAVILY_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                query,
                max_results: maxResults,
                include_answer: true,
                search_depth: "basic",
            }),
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            console.error(`[WebSearch] Tavily ${res.status}:`, detail.slice(0, 200));
            return "Web search failed, couldn't reach the search provider.";
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
            lines.push(`[${i + 1}] ${r.title}\n${r.url}\n${r.content}`);
        });

        return lines.join("\n");
    } catch (err) {
        console.error("[WebSearch] failed:", err);
        return "Web search failed, please try again later.";
    }
}

// Real web results using Gemini's native Google Search grounding — no extra API
// key needed beyond GEMINI_API_KEY. Returns the grounded answer plus source URLs.
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

/** Search the web via Tavily if configured, otherwise Gemini Google-Search grounding. */
export async function runWebSearch(query: string): Promise<string> {
    return TAVILY_API_KEY ? webSearch(query) : geminiWebSearch(query);
}
