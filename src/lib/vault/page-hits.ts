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
