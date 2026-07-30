"use client";

import { ArrowRight, Route, X } from "lucide-react";
import { styles } from "../cosmos/styles";
import { COSMOS } from "../cosmos/palette";
import type { GraphNode } from "../cosmos/model";
import { PanelShell } from "./ui";

export default function PathPanel({ from, to, path, titleOf, onFocus, onClear, onSwap }: {
    from: string | null;
    to: string | null;
    path: string[];
    titleOf(path: string): string;
    onFocus(path: string): void;
    onClear(): void;
    onSwap(): void;
}) {
    const complete = from !== null && to !== null;
    const found = path.length > 0;

    return (
        <PanelShell
            icon={<Route size={15} />}
            title="Route"
            subtitle={
                !complete
                    ? "Right-click a star to set each end"
                    : found
                        ? `${path.length - 1} hop${path.length - 1 === 1 ? "" : "s"} between them`
                        : "No chain of links connects these two"
            }
            aside={
                <button style={styles.iconBtn} onClick={onClear} aria-label="Clear route" title="Clear route">
                    <X size={13} />
                </button>
            }
        >
            <div style={styles.listStack}>
                <div style={{ ...styles.listRow, cursor: "default" }}>
                    <span style={styles.listRowLead}>A</span>
                    <span style={styles.resultTitle}>{from ? titleOf(from) : "Not set"}</span>
                </div>
                <div style={{ ...styles.listRow, cursor: "default" }}>
                    <span style={styles.listRowLead}>B</span>
                    <span style={styles.resultTitle}>{to ? titleOf(to) : "Not set"}</span>
                </div>
            </div>

            {complete && (
                <div style={styles.actionRow}>
                    <button style={styles.action} onClick={onSwap}>
                        <ArrowRight size={12} /> Swap ends
                    </button>
                </div>
            )}

            {found && (
                <>
                    <div style={styles.sectionLabel}>Corridor</div>
                    <div style={styles.listStack}>
                        {path.map((step, index) => (
                            <button key={step} style={styles.listRow} onClick={() => onFocus(step)}>
                                <span style={styles.listRowLead}>{index + 1}</span>
                                <span style={styles.resultTitle}>{titleOf(step)}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}

            {complete && !found && (
                <div style={{ ...styles.empty, color: COSMOS.muted }}>
                    These pages sit in separate parts of the vault. That is itself worth knowing: a
                    link between them would join two disconnected regions.
                </div>
            )}
        </PanelShell>
    );
}

export function pathHopTitle(node: GraphNode | undefined, fallback: string): string {
    return node?.title ?? fallback;
}
