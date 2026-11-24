/** Hybrid recall ranks sections, best first, so the first hit for a path is that page's best section. */
export function firstHitPerPage<T extends { path: string }>(hits: readonly T[], limit = Infinity): T[] {
    const seen = new Set<string>();
    const pages: T[] = [];
    for (const hit of hits) {
        if (pages.length >= limit) break;
        if (seen.has(hit.path)) continue;
        seen.add(hit.path);
        pages.push(hit);
    }
    return pages;
}

/**
 * One row per page for the graph search, scored on the recall scale. The scores are handed out best first in hit order,
 * so a rerank model's order survives the client's sort by score; for hits already in score order nothing changes.
 * Rerank model scores are not used: they sit on another scale (Nemotron 3.5 Rerank gave -1.9 to -3.5 on 24/11/2026).
 */
export function graphSearchPages(hits: readonly { path: string; title: string; similarity: number; score?: { final: number } }[]): { path: string; title: string; similarity: number }[] {
    const pages = firstHitPerPage(hits);
    const scores = pages.map((hit) => Math.max(0, Math.min(1, hit.score?.final ?? hit.similarity))).sort((a, b) => b - a);
    return pages.map((hit, index) => ({ path: hit.path, title: hit.title, similarity: scores[index] }));
}
