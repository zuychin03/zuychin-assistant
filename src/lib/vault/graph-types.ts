export const NODE_HEALTH = ["orphan", "stale", "dangling", "malformed", "unreviewed"] as const;
export type NodeHealth = (typeof NODE_HEALTH)[number];

export interface GraphNode {
    id: string; // repo path, e.g. wiki/concepts/attention.md
    title: string;
    category: string;
    summary: string;
    links: number;
    updated: string | null;
    created: string | null;
    trust: "trusted" | "reviewed" | "untrusted";
    status: "active" | "suggested" | "superseded" | "archived" | "deleted";
    scope: string;
    sensitivity: string;
    kind: string;
    /** Label-propagation community; -1 when the page has no cluster. */
    cluster: number;
    /** PageRank normalised so the most central page scores 1. */
    centrality: number;
    words: number;
    health: NodeHealth[];
    /** Outbound wikilinks whose destination page does not exist. */
    dangling: number;
}

export interface GraphEdge {
    source: string;
    target: string;
    /** True when both pages link to each other. */
    mutual: boolean;
}

export interface LinkSuggestion {
    source: string;
    target: string;
    similarity: number;
}

export interface GraphCluster {
    id: number;
    size: number;
    /** Title of the highest-centrality member, used as the constellation name. */
    label: string;
    categoryMix: Record<string, number>;
    centroidPath: string;
}

export type HealthSummary = Record<NodeHealth, number>;

export interface VaultGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    suggestions: LinkSuggestion[];
    clusters: GraphCluster[];
    health: HealthSummary;
    builtAt: string;
    /** Set when the payload came from a snapshot past its revalidation window. */
    stale?: boolean;
}
