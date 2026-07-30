"use client";

import { useMemo } from "react";
import { Activity, Orbit, Stethoscope } from "lucide-react";
import { CLUSTER_PALETTE, HEALTH_COLORS, HEALTH_LABELS, HEALTH_PRIORITY } from "../cosmos/palette";
import { styles } from "../cosmos/styles";
import type { GraphCluster, GraphNode, HealthSummary, NodeHealth } from "../cosmos/model";
import { PanelShell } from "./ui";

export function ClustersPanel({ clusters, onFocus }: {
    clusters: GraphCluster[];
    onFocus(path: string): void;
}) {
    return (
        <PanelShell
            icon={<Orbit size={15} />}
            title="Constellations"
            subtitle={clusters.length ? `${clusters.length} detected communities` : "No communities detected yet"}
        >
            {clusters.length === 0 && (
                <div style={styles.empty}>
                    Clusters appear once pages start linking to each other.
                </div>
            )}
            <div style={styles.listStack}>
                {clusters.slice(0, 10).map((cluster) => {
                    const dominant = Object.entries(cluster.categoryMix).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
                    return (
                        <button key={cluster.id} style={styles.listRow} onClick={() => onFocus(cluster.centroidPath)}>
                            <span style={{ ...styles.chipDot, background: CLUSTER_PALETTE[cluster.id % CLUSTER_PALETTE.length] }} />
                            <span style={styles.resultTitle}>{cluster.label}</span>
                            <span style={styles.listRowMeta}>{dominant} · {cluster.size}</span>
                        </button>
                    );
                })}
            </div>
        </PanelShell>
    );
}

export function HealthPanel({ health, nodes, activeFindings, onToggleFinding, onFocus }: {
    health: HealthSummary;
    nodes: GraphNode[];
    activeFindings: NodeHealth[];
    onToggleFinding(finding: NodeHealth): void;
    onFocus(path: string): void;
}) {
    const total = HEALTH_PRIORITY.reduce((sum, finding) => sum + (health[finding] ?? 0), 0);
    const offenders = useMemo(() => {
        if (activeFindings.length === 0) return [];
        return nodes
            .filter((node) => activeFindings.some((finding) => node.health.includes(finding)))
            .sort((a, b) => b.centrality - a.centrality)
            .slice(0, 10);
    }, [nodes, activeFindings]);

    return (
        <PanelShell
            icon={<Stethoscope size={15} />}
            title="Vault health"
            subtitle={total === 0 ? "Nothing needs attention" : `${total} finding${total === 1 ? "" : "s"} across the vault`}
        >
            <div style={styles.listStack}>
                {HEALTH_PRIORITY.map((finding) => {
                    const count = health[finding] ?? 0;
                    const active = activeFindings.includes(finding);
                    return (
                        <button
                            key={finding}
                            style={{
                                ...styles.listRow,
                                opacity: count === 0 ? 0.45 : 1,
                                borderLeftWidth: 3,
                                borderLeftStyle: "solid",
                                borderLeftColor: active ? HEALTH_COLORS[finding] : "transparent",
                            }}
                            onClick={() => onToggleFinding(finding)}
                            disabled={count === 0}
                            aria-pressed={active}
                        >
                            <span style={{ ...styles.chipDot, background: HEALTH_COLORS[finding] }} />
                            <span style={styles.resultTitle}>{HEALTH_LABELS[finding]}</span>
                            <span style={styles.listRowMeta}>{count}</span>
                        </button>
                    );
                })}
            </div>

            {offenders.length > 0 && (
                <>
                    <div style={styles.sectionLabel}>Offenders</div>
                    <div style={styles.listStack}>
                        {offenders.map((node) => (
                            <button key={node.id} style={styles.listRow} onClick={() => onFocus(node.id)}>
                                <span style={styles.resultTitle}>{node.title}</span>
                                <span style={styles.listRowMeta}>{node.links} links</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </PanelShell>
    );
}

export function HubsPanel({ nodes, onFocus }: {
    nodes: GraphNode[];
    onFocus(path: string): void;
}) {
    const { hubs, fringe } = useMemo(() => {
        const connected = nodes.filter((node) => node.links > 0);
        return {
            hubs: [...connected].sort((a, b) => b.centrality - a.centrality || b.links - a.links).slice(0, 6),
            fringe: [...connected].sort((a, b) => a.links - b.links || a.centrality - b.centrality).slice(0, 6),
        };
    }, [nodes]);

    return (
        <PanelShell
            icon={<Activity size={15} />}
            title="Gravity wells"
            subtitle="What the vault is organised around"
        >
            {hubs.length === 0 && <div style={styles.empty}>No connected pages yet.</div>}
            {hubs.length > 0 && (
                <>
                    <div style={styles.sectionLabel}>Most central</div>
                    <div style={styles.listStack}>
                        {hubs.map((node, index) => (
                            <button key={node.id} style={styles.listRow} onClick={() => onFocus(node.id)}>
                                <span style={styles.listRowLead}>{index + 1}</span>
                                <span style={styles.resultTitle}>{node.title}</span>
                                <span style={styles.listRowMeta}>{node.links}</span>
                            </button>
                        ))}
                    </div>
                    <div style={styles.sectionLabel}>Barely held</div>
                    <div style={styles.listStack}>
                        {fringe.map((node) => (
                            <button key={node.id} style={styles.listRow} onClick={() => onFocus(node.id)}>
                                <span style={styles.resultTitle}>{node.title}</span>
                                <span style={styles.listRowMeta}>{node.links}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </PanelShell>
    );
}
