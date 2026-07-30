// Pure graph analytics over the vault adjacency. Kept deterministic on purpose:
// cluster ids drive palette assignment, so a rebuild that reshuffles them would
// recolour the whole view for no reason.

export type Adjacency = Map<string, Set<string>>;

const MAX_PASSES = 12;
const DAMPING = 0.85;
const PAGERANK_ITERATIONS = 30;
// Above 1 favours more, smaller communities. Tuned against the live vault, where
// plain modularity (1.0) still merged most topics into a single blob.
const RESOLUTION = 1.35;

/**
 * Communities by greedy modularity optimisation (the local-moving phase of
 * Louvain), with a resolution term.
 *
 * Label propagation was tried first and collapsed: on a densely linked vault it
 * pulled ~85% of pages into one community, which makes a cluster-coloured view
 * useless. Modularity compares each node's links into a community against what
 * chance would predict, so it splits a dense graph instead of swallowing it.
 * Resolution above 1 biases toward smaller, more numerous communities.
 *
 * Nodes are visited in a fixed order and ties break to the lowest community key,
 * so the result is deterministic. Returned ids are renumbered by size descending,
 * so cluster 0 is always the largest. Singletons get -1.
 */
export function clusterNodes(nodeIds: string[], adjacency: Adjacency, resolution = RESOLUTION): Map<string, number> {
    const degree = new Map<string, number>();
    let twoM = 0;
    for (const id of nodeIds) {
        const size = adjacency.get(id)?.size ?? 0;
        degree.set(id, size);
        twoM += size;
    }
    if (twoM === 0) return new Map(nodeIds.map((id) => [id, -1]));

    // A community is keyed by the id of whichever node founded it.
    const label = new Map<string, string>();
    const communityDegree = new Map<string, number>();
    for (const id of nodeIds) {
        label.set(id, id);
        communityDegree.set(id, degree.get(id)!);
    }

    const order = [...nodeIds].sort((a, b) => {
        const da = degree.get(a) ?? 0;
        const db = degree.get(b) ?? 0;
        return db - da || (a < b ? -1 : a > b ? 1 : 0);
    });

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        let moved = false;
        for (const id of order) {
            const k = degree.get(id) ?? 0;
            if (k === 0) continue;
            const own = label.get(id)!;

            // Detach first: the gain for staying must not count this node's own
            // degree as part of the community it is being compared against.
            communityDegree.set(own, (communityDegree.get(own) ?? 0) - k);

            const linksTo = new Map<string, number>([[own, 0]]);
            for (const neighbour of adjacency.get(id) ?? []) {
                const target = label.get(neighbour);
                if (target === undefined) continue;
                linksTo.set(target, (linksTo.get(target) ?? 0) + 1);
            }

            let best = own;
            let bestGain = (linksTo.get(own) ?? 0) - (resolution * (communityDegree.get(own) ?? 0) * k) / twoM;
            for (const [candidate, weight] of [...linksTo.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
                if (candidate === own) continue;
                const gain = weight - (resolution * (communityDegree.get(candidate) ?? 0) * k) / twoM;
                if (gain > bestGain + 1e-12) {
                    bestGain = gain;
                    best = candidate;
                }
            }

            communityDegree.set(best, (communityDegree.get(best) ?? 0) + k);
            if (best !== own) {
                label.set(id, best);
                moved = true;
            }
        }
        if (!moved) break;
    }

    const groups = new Map<string, string[]>();
    for (const id of nodeIds) {
        const key = label.get(id)!;
        const group = groups.get(key);
        if (group) group.push(id);
        else groups.set(key, [id]);
    }

    const ranked = [...groups.values()]
        .map((members) => members.sort())
        .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));

    const result = new Map<string, number>();
    let next = 0;
    for (const members of ranked) {
        const id = members.length > 1 ? next++ : -1;
        for (const member of members) result.set(member, id);
    }
    return result;
}

/**
 * PageRank over the undirected adjacency, normalised so the most central page
 * scores 1. Drives star luminosity, label priority and the hub rankings.
 */
export function pageRank(nodeIds: string[], adjacency: Adjacency): Map<string, number> {
    const count = nodeIds.length;
    const scores = new Map<string, number>();
    if (count === 0) return scores;

    const base = (1 - DAMPING) / count;
    for (const id of nodeIds) scores.set(id, 1 / count);

    for (let iteration = 0; iteration < PAGERANK_ITERATIONS; iteration++) {
        const next = new Map<string, number>();
        for (const id of nodeIds) next.set(id, base);

        for (const id of nodeIds) {
            const neighbours = adjacency.get(id);
            const score = scores.get(id) ?? 0;
            if (!neighbours || neighbours.size === 0) {
                // Dangling mass spreads uniformly rather than leaking out of the system.
                const share = (DAMPING * score) / count;
                for (const other of nodeIds) next.set(other, (next.get(other) ?? 0) + share);
                continue;
            }
            const share = (DAMPING * score) / neighbours.size;
            for (const neighbour of neighbours) {
                next.set(neighbour, (next.get(neighbour) ?? 0) + share);
            }
        }
        for (const [id, value] of next) scores.set(id, value);
    }

    const max = Math.max(...scores.values());
    if (max > 0) {
        for (const [id, value] of scores) scores.set(id, value / max);
    }
    return scores;
}

/** Shortest hop chain between two pages, inclusive of both ends; empty when unreachable. */
export function shortestPath(from: string, to: string, adjacency: Adjacency): string[] {
    if (from === to) return [from];
    const previous = new Map<string, string | null>([[from, null]]);
    const queue = [from];

    for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        for (const neighbour of adjacency.get(current) ?? []) {
            if (previous.has(neighbour)) continue;
            previous.set(neighbour, current);
            if (neighbour === to) {
                const path = [to];
                let step = current;
                while (step !== from) {
                    path.push(step);
                    step = previous.get(step)!;
                }
                path.push(from);
                return path.reverse();
            }
            queue.push(neighbour);
        }
    }
    return [];
}
