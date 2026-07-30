import type { GraphNode, NodeHealth } from "@/lib/vault/graph-types";

// The graph is deliberately dark-only: it reads as a separate place in the app,
// and one committed palette beats two compromised ones. Nothing here reads a CSS
// variable, so the view is identical under either app theme.

export const COSMOS = {
    background: "#05060a",
    filament: "#3d4863",
    filamentMutual: "#5c6b91",
    suggestion: "#7aa2ff",
    dust: "#191d2b",
    text: "#e8ecf8",
    muted: "#8b93ad",
    panel: "rgba(11,13,22,0.82)",
    panelSolid: "#0b0d16",
    border: "rgba(126,141,184,0.18)",
    borderStrong: "rgba(126,141,184,0.34)",
    danger: "#ff5470",
} as const;

export const CATEGORY_COLORS: Record<string, string> = {
    sources: "#ffb545",
    concepts: "#6ba7ff",
    entities: "#45e0a8",
    synthesis: "#c07bff",
};

export const CATEGORIES = ["sources", "concepts", "entities", "synthesis"] as const;

// Walked in cluster-id order. Cluster ids are size-ranked and stable across
// builds, so a constellation keeps its colour.
export const CLUSTER_PALETTE = [
    "#6ba7ff", "#ffb545", "#45e0a8", "#c07bff",
    "#ff7a9a", "#5ce1e6", "#ffd76e", "#a0f06a",
];

export const TRUST_BUCKETS = ["trusted", "reviewed", "unreviewed", "retired"] as const;
export type TrustBucket = (typeof TRUST_BUCKETS)[number];

// Reviewed gets its own baseline hue rather than borrowing the category colour:
// almost every page is reviewed, so reusing the category palette made the trust
// lens indistinguishable from the category lens.
export const TRUST_COLORS: Record<TrustBucket, string> = {
    trusted: "#dce8ff",
    reviewed: "#5f7db3",
    unreviewed: "#ff7a59",
    retired: "#6a7086",
};

export const TRUST_LABELS: Record<TrustBucket, string> = {
    trusted: "Trusted",
    reviewed: "Reviewed",
    unreviewed: "Unreviewed or suggested",
    retired: "Archived or superseded",
};

export function trustBucket(node: GraphNode): TrustBucket {
    if (node.status === "archived" || node.status === "superseded" || node.status === "deleted") return "retired";
    if (node.trust === "untrusted" || node.status === "suggested") return "unreviewed";
    if (node.trust === "trusted") return "trusted";
    return "reviewed";
}

export const HEALTH_COLORS: Record<NodeHealth, string> = {
    malformed: "#ff3d6e",
    dangling: "#ffa23a",
    unreviewed: "#ff7a59",
    stale: "#a8632f",
    orphan: "#6c7a99",
};

export const HEALTH_LABELS: Record<NodeHealth, string> = {
    malformed: "Malformed frontmatter",
    dangling: "Links to nothing",
    unreviewed: "Unreviewed",
    stale: "Stale",
    orphan: "Orphan",
};

// Most actionable first; a node showing several findings is coloured by the worst.
export const HEALTH_PRIORITY: NodeHealth[] = ["malformed", "dangling", "unreviewed", "stale", "orphan"];

export const LENSES = ["category", "cluster", "trust", "health", "recency"] as const;
export type Lens = (typeof LENSES)[number];

export const LENS_LABELS: Record<Lens, string> = {
    category: "Category",
    cluster: "Constellation",
    trust: "Trust",
    health: "Health",
    recency: "Recency",
};

export const LENS_HINTS: Record<Lens, string> = {
    category: "Spectral family per vault folder",
    cluster: "Detected communities, largest first",
    trust: "Reviewed, unreviewed and retired pages",
    health: "Only problems stay lit",
    recency: "Hot means recently touched",
};

export type StarClass = "star" | "protostar" | "giant" | "dwarf";

/**
 * Which star a page reads as. Retired pages burn out, unreviewed ones never
 * finished collapsing into a core, and long-untouched ones cool and swell.
 */
export function classifyStar(node: GraphNode): StarClass {
    if (node.status === "archived" || node.status === "superseded" || node.status === "deleted") return "dwarf";
    if (node.trust === "untrusted" || node.status === "suggested") return "protostar";
    if (node.health.includes("stale")) return "giant";
    return "star";
}

function lerpHex(from: string, to: string, t: number): string {
    const parse = (hex: string) => [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
    ];
    const [r1, g1, b1] = parse(from);
    const [r2, g2, b2] = parse(to);
    const clamped = Math.max(0, Math.min(1, t));
    const mix = (a: number, b: number) => Math.round(a + (b - a) * clamped);
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    return `#${hex(mix(r1, r2))}${hex(mix(g1, g2))}${hex(mix(b1, b2))}`;
}

const RECENCY_STOPS: [number, string][] = [
    [0, "#dce9ff"],
    [7, "#8fc2ff"],
    [30, "#ffd76e"],
    [120, "#ff9f45"],
    [365, "#e0553f"],
    [900, "#7a2f28"],
];

/** Colour temperature for an age in days. Pure, so legends can call it directly. */
export function recencyColorFromDays(days: number): string {
    const age = Math.max(0, days);
    for (let i = 1; i < RECENCY_STOPS.length; i++) {
        const [maxDays, color] = RECENCY_STOPS[i];
        const [prevDays, prevColor] = RECENCY_STOPS[i - 1];
        if (age <= maxDays) {
            return lerpHex(prevColor, color, (age - prevDays) / (maxDays - prevDays));
        }
    }
    return RECENCY_STOPS.at(-1)![1];
}

export function recencyColor(updated: string | null): string {
    if (!updated) return "#4a4f63";
    const parsed = Date.parse(updated);
    if (Number.isNaN(parsed)) return "#4a4f63";
    return recencyColorFromDays((Date.now() - parsed) / 86_400_000);
}

export function clusterColor(cluster: number): string {
    if (cluster < 0) return COSMOS.dust;
    return CLUSTER_PALETTE[cluster % CLUSTER_PALETTE.length];
}

export function worstFinding(node: GraphNode): NodeHealth | null {
    for (const finding of HEALTH_PRIORITY) {
        if (node.health.includes(finding)) return finding;
    }
    return null;
}

/** The lens decides colour and nothing else, so switching never moves a star. */
export function lensColor(node: GraphNode, lens: Lens): string {
    const category = CATEGORY_COLORS[node.category] ?? "#8891a8";

    switch (lens) {
        case "cluster":
            return clusterColor(node.cluster);
        case "recency":
            return recencyColor(node.updated);
        case "trust":
            return TRUST_COLORS[trustBucket(node)];
        case "health": {
            const finding = worstFinding(node);
            return finding ? HEALTH_COLORS[finding] : COSMOS.dust;
        }
        default:
            return category;
    }
}

/**
 * How far the active lens pushes a page into the background, as an opacity
 * multiplier. Single source of truth: the renderer fades the star by it and the
 * label layer hides text below LABEL_VISIBILITY_FLOOR, so a dimmed star never
 * leaves its name floating on its own.
 */
export function lensOpacity(node: GraphNode, lens: Lens): number {
    if (lens === "health") return node.health.length === 0 ? 0.18 : 1;
    if (lens === "trust") {
        const bucket = trustBucket(node);
        if (bucket === "reviewed") return 0.5;
        if (bucket === "retired") return 0.32;
    }
    return 1;
}

export const LABEL_VISIBILITY_FLOOR = 0.35;

/** Sprite scale: mass from degree, with centrality adding a little swell. */
export function starSize(node: GraphNode): number {
    return (5 + Math.cbrt(1 + node.links) * 4.4) * (0.85 + node.centrality * 0.55);
}
