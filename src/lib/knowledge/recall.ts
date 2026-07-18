import type { KnowledgeRecallHit, KnowledgeScoreBreakdown } from "@/lib/knowledge/types";

export interface ScoreInput {
    semantic: number;
    lexical: number;
    graph?: number;
    trust?: "trusted" | "reviewed" | "untrusted";
    kind?: "document" | "semantic" | "episodic" | "procedural" | "working";
    ageDays?: number;
    importance?: number;
}

function clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function computeKnowledgeScore(input: ScoreInput): KnowledgeScoreBreakdown {
    const authority = input.trust === "trusted" ? 1 : input.trust === "untrusted" ? 0.25 : 0.75;
    const freshness = input.kind === "episodic"
        ? Math.exp(-Math.max(0, input.ageDays ?? 0) / 90)
        : 1;
    const importance = clamp(input.importance ?? 0.5);
    const semantic = clamp(input.semantic);
    const lexical = clamp(input.lexical);
    const graph = clamp(input.graph ?? 0);
    const final = clamp(
        semantic * 0.45
        + lexical * 0.25
        + graph * 0.1
        + authority * 0.1
        + freshness * 0.05
        + importance * 0.05,
    );
    return { semantic, lexical, graph, authority, freshness, importance, final };
}

function terms(value: string): Set<string> {
    return new Set(
        value.toLowerCase()
            .match(/[a-z0-9][a-z0-9_-]{1,}/g)
            ?.filter((term) => !STOP_WORDS.has(term)) ?? [],
    );
}

const STOP_WORDS = new Set([
    "about", "after", "also", "and", "are", "can", "for", "from", "have", "how",
    "into", "its", "not", "that", "the", "their", "then", "this", "was", "what",
    "when", "where", "which", "with", "would", "you", "your",
]);

export function lexicalSupport(query: string, evidence: string): number {
    const queryTerms = terms(query);
    const evidenceTerms = terms(evidence);
    if (!queryTerms.size || !evidenceTerms.size) return 0;
    let overlap = 0;
    for (const term of queryTerms) if (evidenceTerms.has(term)) overlap++;
    return overlap / queryTerms.size;
}

export interface GroundedRecall {
    supported: boolean;
    support: number;
    answer: string;
    citations: { path: string; heading: string; chunkId: string }[];
}

export function groundRecall(
    query: string,
    hits: KnowledgeRecallHit[],
    threshold = 0.3,
): GroundedRecall {
    if (!hits.length) {
        return {
            supported: false,
            support: 0,
            answer: "I could not find supporting knowledge for that request.",
            citations: [],
        };
    }

    const ranked = hits.map((hit) => ({
        hit,
        support: Math.max(
            hit.score.semantic,
            lexicalSupport(query, `${hit.title} ${hit.heading} ${hit.excerpt}`),
        ),
    })).sort((a, b) => b.support - a.support);

    if (ranked[0].support < threshold) {
        return {
            supported: false,
            support: ranked[0].support,
            answer: "The knowledge base does not contain enough evidence to answer confidently.",
            citations: [],
        };
    }

    const selected = ranked.filter((item) => item.support >= threshold).slice(0, 3);
    return {
        supported: true,
        support: selected[0].support,
        answer: selected.map(({ hit }) => {
            const anchor = hit.heading ? `#${encodeURIComponent(hit.heading)}` : "";
            return `${hit.excerpt.trim()} ([${hit.title}](vault://${hit.path}${anchor}))`;
        }).join("\n\n"),
        citations: selected.map(({ hit }) => ({
            path: hit.path,
            heading: hit.heading,
            chunkId: hit.chunkId,
        })),
    };
}
