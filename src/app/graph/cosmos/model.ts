import type {
    GraphCluster, GraphEdge, GraphNode, HealthSummary, LinkSuggestion, NodeHealth,
} from "@/lib/vault/graph-types";
import { shortestPath, type Adjacency } from "@/lib/vault/graph-analysis";
import { trustBucket, type Lens, type TrustBucket } from "./palette";

export type { GraphCluster, GraphEdge, GraphNode, HealthSummary, LinkSuggestion, NodeHealth };
export { shortestPath };
export type { Adjacency };

export interface ApiGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    suggestions: LinkSuggestion[];
    clusters: GraphCluster[];
    health: HealthSummary;
    builtAt: string;
    stale?: boolean;
}

/** Force-simulation positions are written onto these by the graph library. */
export interface GNode extends GraphNode {
    x?: number;
    y?: number;
    z?: number;
}

export type LinkKind = "real" | "suggestion";

export interface GLink {
    source: string | GNode;
    target: string | GNode;
    kind: LinkKind;
    mutual: boolean;
    similarity?: number;
}

export interface SelectedLink {
    source: string;
    target: string;
    kind: LinkKind;
    similarity?: number;
}

export function endpoints(link: GLink): { s: string; t: string } {
    return {
        s: typeof link.source === "string" ? link.source : link.source.id,
        t: typeof link.target === "string" ? link.target : link.target.id,
    };
}

export function pairKey(a: string, b: string): string {
    return [a, b].sort().join("|");
}

export function linkKey(link: GLink): string {
    const { s, t } = endpoints(link);
    return `${link.kind}:${pairKey(s, t)}`;
}

/**
 * Everything the renderer reads while styling. Held as one mutable object rather
 * than React state so hover and search restyles never trigger a re-render.
 */
export interface CosmosView {
    lens: Lens;
    hover: string | null;
    selectedNode: string | null;
    selectedLink: SelectedLink | null;
    highlightNodes: Set<string>;
    highlightLinks: Set<string>;
    /** path -> 0..1 relevance. Empty when no search is running. */
    searchScores: Map<string, number>;
    searchActive: boolean;
    pathNodes: Set<string>;
    pathLinks: Set<string>;
    pathActive: boolean;
    labelsOn: boolean;
    /**
     * Id of the page whose system is open, or null. deriveVisible has already dropped
     * everything beyond localDepth hops, so this only says which of the survivors is
     * the root: it stays lit, its neighbours sink into the background.
     */
    systemFocus: string | null;
    /** Screen bands covered by the side rails; labels there would sit under a panel. */
    labelSafeArea: { left: number; right: number };
}

/** Dimming applied to a neighbouring system while one system is entered. */
export const SYSTEM_BACKGROUND_OPACITY = 0.26;

export function createView(): CosmosView {
    return {
        lens: "category",
        hover: null,
        selectedNode: null,
        selectedLink: null,
        highlightNodes: new Set(),
        highlightLinks: new Set(),
        searchScores: new Map(),
        searchActive: false,
        pathNodes: new Set(),
        pathLinks: new Set(),
        pathActive: false,
        labelsOn: true,
        systemFocus: null,
        labelSafeArea: { left: 0, right: 0 },
    };
}

export function buildAdjacency(edges: GraphEdge[]): Adjacency {
    const map: Adjacency = new Map();
    for (const edge of edges) {
        if (!map.has(edge.source)) map.set(edge.source, new Set());
        if (!map.has(edge.target)) map.set(edge.target, new Set());
        map.get(edge.source)!.add(edge.target);
        map.get(edge.target)!.add(edge.source);
    }
    return map;
}

export interface VisibleParams {
    data: ApiGraph;
    adjacency: Adjacency;
    categoryFilter: Record<string, boolean>;
    showOrphans: boolean;
    showSuggestions: boolean;
    localRoot: string | null;
    localDepth: 1 | 2;
    /** Epoch ms; nodes created after this are unborn. Null disables the filter. */
    timeCutoff: number | null;
    /** Restrict to pages carrying at least one health finding. */
    onlyFindings: NodeHealth[] | null;
    /** Restrict to pages in one of these trust buckets. */
    onlyTrust: TrustBucket[] | null;
    nodeCache: Map<string, GNode>;
    linkCache: Map<string, GLink>;
}

export interface VisibleSlice {
    nodes: GNode[];
    links: GLink[];
}

/**
 * The rendered slice. Node objects are reused from the caches so the force layout
 * keeps its positions when filters change instead of exploding on every toggle.
 */
export function deriveVisible(params: VisibleParams): VisibleSlice {
    const {
        data, adjacency, categoryFilter, showOrphans, showSuggestions,
        localRoot, localDepth, timeCutoff, onlyFindings, onlyTrust, nodeCache, linkCache,
    } = params;

    let keep = new Set(
        data.nodes
            .filter((node) => categoryFilter[node.category] !== false)
            .filter((node) => showOrphans || node.links > 0)
            .filter((node) => {
                if (timeCutoff === null || !node.created) return true;
                const born = Date.parse(node.created);
                return Number.isNaN(born) || born <= timeCutoff;
            })
            .filter((node) => !onlyFindings || onlyFindings.some((finding) => node.health.includes(finding)))
            .filter((node) => !onlyTrust || onlyTrust.includes(trustBucket(node)))
            .map((node) => node.id),
    );

    if (localRoot && keep.has(localRoot)) {
        const within = new Set([localRoot]);
        let frontier = [localRoot];
        for (let depth = 0; depth < localDepth; depth++) {
            const next: string[] = [];
            for (const id of frontier) {
                for (const neighbour of adjacency.get(id) ?? []) {
                    if (!within.has(neighbour) && keep.has(neighbour)) {
                        within.add(neighbour);
                        next.push(neighbour);
                    }
                }
            }
            frontier = next;
        }
        keep = within;
    }

    const nodes: GNode[] = [];
    for (const node of data.nodes) {
        if (!keep.has(node.id)) continue;
        const cached = nodeCache.get(node.id);
        if (cached) {
            Object.assign(cached, node);
            nodes.push(cached);
        } else {
            const fresh: GNode = { ...node };
            nodeCache.set(node.id, fresh);
            nodes.push(fresh);
        }
    }

    const links: GLink[] = [];
    const push = (s: string, t: string, kind: LinkKind, mutual: boolean, similarity?: number) => {
        if (!keep.has(s) || !keep.has(t)) return;
        const key = `${kind}:${pairKey(s, t)}`;
        const cached = linkCache.get(key);
        if (cached) {
            cached.mutual = mutual;
            cached.similarity = similarity;
            links.push(cached);
        } else {
            const fresh: GLink = { source: s, target: t, kind, mutual, similarity };
            linkCache.set(key, fresh);
            links.push(fresh);
        }
    };

    for (const edge of data.edges) push(edge.source, edge.target, "real", edge.mutual);
    if (showSuggestions) {
        for (const suggestion of data.suggestions) {
            push(suggestion.source, suggestion.target, "suggestion", false, suggestion.similarity);
        }
    }
    return { nodes, links };
}

/** Earliest known page birth, for the time scrubber's left edge. */
export function earliestCreated(nodes: GraphNode[]): number | null {
    let earliest: number | null = null;
    for (const node of nodes) {
        if (!node.created) continue;
        const parsed = Date.parse(node.created);
        if (Number.isNaN(parsed)) continue;
        if (earliest === null || parsed < earliest) earliest = parsed;
    }
    return earliest;
}

export function pathLinkKeys(path: string[]): Set<string> {
    const keys = new Set<string>();
    for (let i = 1; i < path.length; i++) {
        keys.add(`real:${pairKey(path[i - 1], path[i])}`);
    }
    return keys;
}

/**
 * Read-mode rendering: drop the YAML frontmatter (Markdown renders it as a bold
 * run of key: value text) and turn [[path|label]] into its readable label.
 * Edit mode keeps the raw file, frontmatter included.
 */
export function displayMarkdown(markdown: string): string {
    const body = markdown.startsWith("---")
        ? markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
        : markdown;
    return body.replace(/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_match, path: string, label?: string) => {
        const text = label?.trim() || path.replace(/\.md$/, "").split("/").pop()!.replace(/-/g, " ");
        return `**${text}**`;
    });
}

export function humanizePath(path: string): string {
    return path.replace(/\.md$/, "").split("/").pop()!.replace(/-/g, " ");
}
