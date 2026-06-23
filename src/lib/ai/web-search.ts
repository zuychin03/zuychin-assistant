// Web search for the non-Gemini models. Those models have no built-in internet
// access, so this hits a search API (Tavily) and returns a short list of results
// the model can read. Gemini doesn't use this - it has its own Google Search
// grounding.

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
