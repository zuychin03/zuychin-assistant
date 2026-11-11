"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import type { GraphEdge, GraphNode } from "@/lib/vault/graph-types";
import styles from "./link-chart.module.css";

export interface LinkGraph { nodes: GraphNode[]; edges: GraphEdge[] }

const FAMILY: Record<string, string> = { sources: "source", concepts: "concept", entities: "entity", synthesis: "synthesis" };
const colour = (category: string) => `var(--fam-${FAMILY[category] ?? "concept"})`;

const W = 640;
const H = 168;
const CX = W / 2;
const CY = H / 2;
const LABELLED_PER_SIDE = 2;

function hash(text: string) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return (value >>> 0) / 4294967295;
}

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

interface Placed { node: GraphNode; x: number; y: number; r: number; side: "in" | "out"; labelled: boolean }

// Deterministic scatter: the same page always draws the same chart.
function place(nodes: GraphNode[], side: "in" | "out", taken: { x: number; y: number }[]): Placed[] {
    const direction = side === "in" ? -1 : 1;
    return nodes.map((node, index) => {
        const labelled = index < LABELLED_PER_SIDE;
        // Labelled dots get their own height bands so their labels cannot collide.
        const [top, bottom] = !labelled ? [18, H - 18] : index === 0 ? [44, 70] : [112, 146];
        let best = { x: CX, y: CY }, bestGap = -1;
        for (let attempt = 0; attempt < 14; attempt += 1) {
            const reach = 62 + hash(`${node.id}:x:${attempt}`) * (CX - 98);
            const candidate = { x: CX + direction * reach, y: top + hash(`${node.id}:y:${attempt}`) * (bottom - top) };
            const gap = Math.min(...taken.map((point) => Math.hypot(point.x - candidate.x, (point.y - candidate.y) * 1.6)), Infinity);
            if (gap > bestGap) { best = candidate; bestGap = gap; }
            if (gap >= 34) break;
        }
        taken.push(best);
        if (labelled) for (const dx of [-60, -30, 0, 30, 60]) taken.push({ x: best.x + dx, y: best.y - 16 });
        return { node, x: Math.round(best.x), y: Math.round(best.y), r: 2.6 + 3.4 * Math.max(0, Math.min(1, node.centrality)), side, labelled };
    });
}

function anchor(x: number) {
    if (x < W * 0.18) return "start";
    if (x > W * 0.82) return "end";
    return "middle";
}

export function LinkChart({ graph, path, onOpen }: { graph: LinkGraph; path: string; onOpen: (path: string) => void }) {
    const [active, setActive] = useState<string | null>(null);
    const layout = useMemo(() => {
        const self = graph.nodes.find((node) => node.id === path);
        if (!self) return null;
        const byId = new Map(graph.nodes.map((node) => [node.id, node]));
        const inbound = new Set<string>(), outbound = new Set<string>();
        for (const edge of graph.edges) {
            if (edge.target === path && edge.source !== path) { inbound.add(edge.source); if (edge.mutual) outbound.add(edge.source); }
            if (edge.source === path && edge.target !== path) { outbound.add(edge.target); if (edge.mutual) inbound.add(edge.target); }
        }
        const pick = (ids: Iterable<string>) => [...ids].map((id) => byId.get(id)).filter((node): node is GraphNode => !!node)
            .sort((a, b) => b.centrality - a.centrality || a.title.localeCompare(b.title));
        // A two-way link counts on both sides but is drawn once, on whichever side is lighter.
        const ins = pick([...inbound].filter((id) => !outbound.has(id)));
        const outs = pick([...outbound].filter((id) => !inbound.has(id)));
        for (const node of pick([...inbound].filter((id) => outbound.has(id)))) (ins.length <= outs.length ? ins : outs).push(node);
        const byCentrality = (a: GraphNode, b: GraphNode) => b.centrality - a.centrality || a.title.localeCompare(b.title);
        ins.sort(byCentrality); outs.sort(byCentrality);
        const taken = [{ x: CX, y: CY }, { x: CX, y: CY + 22 }];
        return { self, inCount: inbound.size, outCount: outbound.size, points: [...place(ins, "in", taken), ...place(outs, "out", taken)] };
    }, [graph, path]);

    if (!layout) return null;
    const { self, inCount, outCount, points } = layout;
    if (!points.length) return <p className={styles.none}>No pages link here yet, and this page links to none.</p>;

    const open = (id: string) => (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(id);
    };
    const label = (point: Placed) => ({ left: `${(point.x / W) * 100}%`, top: `${((point.y - point.r - 4) / H) * 100}%` });

    return <figure className={styles.chart} aria-label={`Links: ${inCount} in, ${outCount} out`}>
        <svg viewBox={`0 0 ${W} ${H}`} className={styles.sky} role="group" aria-label={`${inCount} pages link here; this page links to ${outCount}`}>
            <rect className={styles.frame} x=".5" y=".5" width={W - 1} height={H - 1} rx="8" />
            <path className={styles.grat} d={`M${CX} 6V${H - 6}M8 ${CY}H${W - 8}M${W * 0.25} 10V${H - 10}M${W * 0.75} 10V${H - 10}`} />
            {points.map((point) => <line key={`l-${point.node.id}`} className={styles.link} data-on={active === point.node.id || undefined}
                x1={CX} y1={CY} x2={point.x} y2={point.y} />)}
            {points.map((point) => <g key={point.node.id} className={styles.node} role="button" tabIndex={0}
                aria-label={`${point.node.title}, ${point.side === "in" ? "links here" : "linked from this page"}`}
                onClick={() => onOpen(point.node.id)} onKeyDown={open(point.node.id)}
                onMouseEnter={() => setActive(point.node.id)} onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(point.node.id)} onBlur={() => setActive(null)}>
                <circle className={styles.hit} cx={point.x} cy={point.y} r={Math.max(point.r + 6, 10)} />
                <circle className={styles.knockout} cx={point.x} cy={point.y} r={point.r + 2} />
                {active === point.node.id && <circle className={styles.ring} cx={point.x} cy={point.y} r={point.r + 3.5} />}
                <circle cx={point.x} cy={point.y} r={point.r} fill={colour(point.node.category)} />
            </g>)}
            <circle className={styles.knockout} cx={CX} cy={CY} r={12} />
            <circle className={styles.selfRing} cx={CX} cy={CY} r={9.5} />
            <circle cx={CX} cy={CY} r={6} fill={colour(self.category)} />
        </svg>
        <div className={styles.overlay} aria-hidden="true">
            <span className={styles.count} data-side="in"><strong>{inCount}</strong> in</span>
            <span className={styles.count} data-side="out"><strong>{outCount}</strong> out</span>
            {points.filter((point) => point.labelled || active === point.node.id).map((point) => <span key={point.node.id}
                className={styles.label} data-anchor={anchor(point.x)} data-hover={!point.labelled || undefined} data-on={active === point.node.id || undefined}
                style={label(point)}>{clip(point.node.title, 34)}</span>)}
            <span className={styles.selfLabel} style={{ top: `${((CY + 13) / H) * 100}%` }}>{clip(self.title, 30)}</span>
        </div>
    </figure>;
}
