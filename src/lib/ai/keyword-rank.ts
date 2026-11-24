// Chat recall's own ranking: vector similarity plus query-term hits and a small bonus for past messages. It orders
// memories when no rerank model answers, and breaks ties when one does.

export interface KeywordRankable {
    content: string;
    metadata?: Record<string, string>;
    similarity?: number;
}

export function keywordScore(result: KeywordRankable, query: string): number {
    return scoreWith(result, queryTerms(query));
}

function queryTerms(query: string): Set<string> {
    return new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
}

function scoreWith(result: KeywordRankable, terms: ReadonlySet<string>): number {
    const cosineSim = result.similarity ?? 0.7;
    const contentLower = result.content.toLowerCase();
    let keywordHits = 0;
    for (const term of terms) {
        if (contentLower.includes(term)) keywordHits++;
    }
    const keywordScore = terms.size > 0 ? (keywordHits / terms.size) * 0.2 : 0;
    const recencyBonus = result.metadata?.source === "user_message" ? 0.05 : 0;
    return cosineSim + keywordScore + recencyBonus;
}

export function keywordRank<T extends KeywordRankable>(results: readonly T[], query: string, maxResults: number): (T & { totalScore: number })[] {
    const terms = queryTerms(query);
    const scored = results.map((r) => ({ ...r, totalScore: scoreWith(r, terms) }));
    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored.slice(0, maxResults);
}

/** Orders two results the rerank model scored equally: higher keyword score first. */
export function keywordTieBreak<T extends KeywordRankable>(query: string): (a: T, b: T) => number {
    const terms = queryTerms(query);
    return (a, b) => scoreWith(b, terms) - scoreWith(a, terms);
}
