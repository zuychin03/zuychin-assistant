"use client";

import { useMemo } from "react";
import { Palette } from "lucide-react";
import {
    CATEGORIES, CATEGORY_COLORS, CLUSTER_PALETTE, COSMOS, HEALTH_COLORS, HEALTH_LABELS,
    HEALTH_PRIORITY, LENSES, LENS_HINTS, LENS_LABELS, TRUST_BUCKETS, TRUST_COLORS,
    TRUST_LABELS, recencyColorFromDays, trustBucket, type Lens, type TrustBucket,
} from "../cosmos/palette";
import { styles } from "../cosmos/styles";
import type { GraphCluster, GraphNode } from "../cosmos/model";
import { PanelShell } from "./ui";

function Legend({ entries }: { entries: { color: string; label: string }[] }) {
    return (
        <div style={{ marginTop: 10 }}>
            {entries.map((entry) => (
                <div key={entry.label} style={styles.legendRow}>
                    <span style={{ ...styles.chipDot, background: entry.color }} />
                    {entry.label}
                </div>
            ))}
        </div>
    );
}

const RECENCY_SAMPLES: [string, number][] = [
    ["Today", 0],
    ["This month", 20],
    ["This year", 200],
    ["Over a year", 800],
];

export default function LensPanel({ lens, onLens, clusters, nodes, trustFilter, onToggleTrust }: {
    lens: Lens;
    onLens(next: Lens): void;
    clusters: GraphCluster[];
    nodes: GraphNode[];
    trustFilter: TrustBucket[];
    onToggleTrust(bucket: TrustBucket): void;
}) {
    const trustCounts = useMemo(() => {
        const counts = { trusted: 0, reviewed: 0, unreviewed: 0, retired: 0 } as Record<TrustBucket, number>;
        for (const node of nodes) counts[trustBucket(node)]++;
        return counts;
    }, [nodes]);

    let legend: { color: string; label: string }[] = [];
    if (lens === "category") {
        legend = CATEGORIES.map((category) => ({ color: CATEGORY_COLORS[category], label: category }));
    } else if (lens === "health") {
        legend = [
            ...HEALTH_PRIORITY.map((finding) => ({ color: HEALTH_COLORS[finding], label: HEALTH_LABELS[finding] })),
            { color: COSMOS.dust, label: "Healthy (dimmed)" },
        ];
    } else if (lens === "recency") {
        legend = RECENCY_SAMPLES.map(([label, days]) => ({ color: recencyColorFromDays(days), label }));
    } else if (lens === "cluster") {
        legend = clusters.slice(0, 6).map((cluster) => ({
            color: CLUSTER_PALETTE[cluster.id % CLUSTER_PALETTE.length],
            label: `${cluster.label} · ${cluster.size}`,
        }));
    }

    return (
        <PanelShell icon={<Palette size={15} />} title="Lens" subtitle={LENS_HINTS[lens]}>
            <div style={styles.lensGrid}>
                {LENSES.map((option, index) => (
                    <button
                        key={option}
                        onClick={() => onLens(option)}
                        style={{ ...styles.lensBtn, ...(lens === option ? styles.lensBtnActive : {}) }}
                        aria-pressed={lens === option}
                        title={`${LENS_LABELS[option]} (press ${index + 1})`}
                    >
                        <span style={styles.resultTitle}>{LENS_LABELS[option]}</span>
                        <span style={styles.keycap}>{index + 1}</span>
                    </button>
                ))}
            </div>

            {/* Trust is the one lens whose legend is also a filter: it doubles as the
                review queue, so each row narrows the graph to that bucket. */}
            {lens === "trust" && (
                <>
                    <div style={styles.sectionLabel}>
                        {trustFilter.length > 0 ? "Filtering to" : "Click to filter"}
                    </div>
                    <div style={styles.listStack}>
                        {TRUST_BUCKETS.map((bucket) => {
                            const count = trustCounts[bucket];
                            const active = trustFilter.includes(bucket);
                            return (
                                <button
                                    key={bucket}
                                    style={{
                                        ...styles.listRow,
                                        opacity: count === 0 ? 0.45 : 1,
                                        borderLeftWidth: 3,
                                        borderLeftStyle: "solid",
                                        borderLeftColor: active ? TRUST_COLORS[bucket] : "transparent",
                                    }}
                                    onClick={() => onToggleTrust(bucket)}
                                    disabled={count === 0}
                                    aria-pressed={active}
                                >
                                    <span style={{ ...styles.chipDot, background: TRUST_COLORS[bucket] }} />
                                    <span style={styles.resultTitle}>{TRUST_LABELS[bucket]}</span>
                                    <span style={styles.listRowMeta}>{count}</span>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}

            {legend.length > 0 && <Legend entries={legend} />}
        </PanelShell>
    );
}
