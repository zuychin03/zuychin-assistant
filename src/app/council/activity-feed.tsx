"use client";

import type { CSSProperties, ReactNode } from "react";
import type { HostActivity, HostAgent } from "./host-client";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// An idle or exited agent's newest entry is history, not what it is doing.
function doing(item: HostActivity | undefined, state: string): string {
    if (state !== "busy" && state !== "starting") return state;
    switch (item?.kind) {
        case "agent_message_chunk": return "writing";
        case "agent_thought_chunk": return "thinking";
        case "tool_call":
        case "terminal": return `running ${item.detail}`;
        default: return state;
    }
}

function entry(item: HostActivity): ReactNode {
    const who = <span style={styles.agent}>{item.agent}</span>;
    switch (item.kind) {
        case "agent_message_chunk":
            return <>{who}<span style={styles.message}>{item.detail.trim()}</span></>;
        case "agent_thought_chunk":
            return (
                <details style={styles.thought}>
                    <summary>{who} <span style={styles.muted}>thinking</span></summary>
                    <span style={styles.thoughtText}>{item.detail.trim()}</span>
                </details>
            );
        case "tool_call":
        case "terminal":
            return <>{who}<span style={styles.muted} aria-hidden="true">›</span><code style={styles.tool}>{clip(item.detail, 240)}</code></>;
        case "permission_request":
            return <>{who}<span style={styles.muted}>asks permission: {clip(item.detail, 240)}</span></>;
        default:
            return <>{who}<span style={styles.muted}>{clip(item.detail, 240)}</span></>;
    }
}

export function ActivityFeed({ activity, agents }: {
    activity: HostActivity[];
    agents: Pick<HostAgent, "name" | "state">[];
}) {
    if (activity.length === 0) return null;
    const latest = new Map<string, HostActivity>();
    for (const item of activity) if (item.agent !== "host") latest.set(item.agent, item);
    return (
        <div style={styles.wrap}>
            {agents.length > 0 && (
                <div style={styles.now}>
                    {agents.map((agent) => (
                        <span key={agent.name} style={styles.nowItem}>
                            <span style={styles.agent}>{agent.name}</span> {clip(doing(latest.get(agent.name), agent.state), 80)}
                        </span>
                    ))}
                </div>
            )}
            <ol style={styles.feed} aria-label="Host activity">
                {activity.slice().reverse().map((item, index) => (
                    <li key={`${item.at}-${index}`} style={styles.row}>{entry(item)}</li>
                ))}
            </ol>
        </div>
    );
}

const styles: Record<string, CSSProperties> = {
    wrap: { marginTop: 14 },
    now: { display: "flex", flexWrap: "wrap", gap: "4px 14px", marginBottom: 8, fontSize: 11.5, color: "var(--color-text-muted)" },
    nowItem: { minWidth: 0, overflowWrap: "anywhere" },
    feed: { listStyle: "none", margin: 0, padding: 0, maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 },
    row: { display: "flex", gap: 8, alignItems: "baseline", fontSize: 11.5, lineHeight: 1.5 },
    agent: { fontWeight: 750, flexShrink: 0, color: "var(--color-text-primary)" },
    message: { minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" },
    muted: { minWidth: 0, overflowWrap: "anywhere", color: "var(--color-text-muted)" },
    tool: { minWidth: 0, overflowWrap: "anywhere", fontSize: 11, color: "var(--color-text-muted)" },
    thought: { flex: 1, minWidth: 0, color: "var(--color-text-muted)" },
    thoughtText: { display: "block", marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
};
