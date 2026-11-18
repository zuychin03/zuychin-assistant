"use client";

import { useId, useState } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { ReplySource, ReplyTrace } from "@/lib/ai/reply-trace";
import { ReplyTraceBody, validTrace } from "./reply-trace";
import { toolInfo } from "./tool-labels";
import { parseAgentActivity } from "@/lib/ai/agent/activity";
import ui from "./reply-sources.module.css";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function vaultFamily(path = "") {
    const lower = path.toLowerCase();
    if (/(^|\/)sources?\//.test(lower)) return "source";
    if (/(^|\/)entit(y|ies)\//.test(lower)) return "entity";
    if (/(^|\/)synthes(is|es)\//.test(lower)) return "synthesis";
    return "concept";
}

function sourceColour(source: ReplySource) {
    if (source.kind === "vault") return `var(--fam-${vaultFamily(source.ref)})`;
    if (source.kind === "fact") return "var(--fam-entity)";
    if (source.kind === "memory") return "var(--faint)";
    return "var(--fam-source)";
}

function sourceText(source: ReplySource): { kind: string; text: string } {
    if (source.kind === "tool") { const info = toolInfo(source.ref ?? source.label); return { kind: info.service, text: info.action }; }
    if (source.kind === "web") return { kind: "Web", text: source.label === "search_web" ? "searched" : source.label };
    if (source.kind === "fact") return { kind: "Fact", text: source.label };
    if (source.kind === "memory") return { kind: "Memory", text: source.label };
    return { kind: "Vault", text: source.detail ? `${source.label}, ${source.detail}` : source.label };
}

export function activitySummary(trace: ReplyTrace) {
    const sources = trace.sources ?? [];
    const parts: string[] = [];
    const agent = parseAgentActivity(trace.agent);
    if (agent?.steps.length) parts.push(`Ran ${plural(agent.steps.length, "step")}`);
    if (agent?.workers.length) parts.push(`Used ${plural(agent.workers.length, "sub-agent")}`);
    for (const tool of agent?.tools ?? []) {
        const phrase = toolInfo(tool.name).activity;
        if (!parts.includes(phrase)) parts.push(phrase);
    }
    for (const source of sources) {
        if (source.kind !== "tool" && source.kind !== "web") continue;
        const phrase = source.kind === "web" ? "Searched the web" : toolInfo(source.ref ?? source.label).activity;
        if (!parts.includes(phrase)) parts.push(phrase);
    }
    if (!parts.includes("Searched the web") && trace.calls.some((call) => call.groundingRequested && call.capabilities?.grounding)) parts.push("Searched the web");
    const count = (kind: ReplySource["kind"]) => sources.filter((source) => source.kind === kind).length;
    if (count("vault")) parts.push(`Read ${plural(count("vault"), "vault page")}`);
    if (count("fact")) parts.push(`Recalled ${plural(count("fact"), "fact")}`);
    if (count("memory")) parts.push(`Matched ${plural(count("memory"), "memory", "memories")}`);
    if (!parts.length) return trace.calls.length ? `Reply details, ${plural(trace.calls.length, "model call")}` : "Reply details";
    return parts.length > 3 ? `${parts.slice(0, 3).join(" · ")} · ${parts.length - 3} more` : parts.join(" · ");
}

export function ReplyActivity({ trace }: { trace: ReplyTrace }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    if (!validTrace(trace)) return null;
    return <>
        <button type="button" className={ui.activity} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>
            <span>{activitySummary(trace)}</span>
            <ChevronRight size={14} aria-hidden="true" />
        </button>
        {open && <ReplyTraceBody trace={trace} id={id} />}
    </>;
}

// Deterministic placement keeps a reply's chart identical between renders and reloads.
function hash(text: string) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return (value >>> 0) / 4294967295;
}

const WIDTH = 300;
const HEIGHT = 92;

function layout(sources: ReplySource[]) {
    const max = Math.max(...sources.map((source) => source.weight), 0.01);
    const span = WIDTH - 96;
    return sources.map((source, index) => {
        const x = sources.length === 1 ? WIDTH / 2 : 48 + (span * index) / (sources.length - 1);
        const lift = hash(`${source.kind}:${source.ref ?? source.label}`);
        const y = 30 + lift * 34 + (index % 2 ? 6 : -6);
        const r = 2.6 + 3.4 * (source.weight / max);
        return { source, x: Math.round(x), y: Math.round(y), r, above: y > HEIGHT / 2 };
    });
}

export function sourcesSummary(sources: ReplySource[]) {
    const kinds = new Map<string, number>();
    for (const source of sources) {
        const { kind } = sourceText(source);
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    const parts = [...kinds].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind} ${count}`);
    return `${plural(sources.length, "source")}: ${parts.length > 3 ? `${parts.slice(0, 3).join(", ")}, ${parts.length - 3} more` : parts.join(", ")}`;
}

// Collapsed by default so a long chat is not a column of charts; each reply opens on its own.
export function SourceChart({ sources, vaultHref, cosmosHref }: {
    sources: ReplySource[];
    vaultHref: (path: string) => string;
    cosmosHref?: string;
}) {
    const [open, setOpen] = useState(false);
    const id = useId();
    if (!sources.length) return null;
    return <>
        <button type="button" className={ui.activity} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>
            <span>{sourcesSummary(sources)}</span>
            <ChevronRight size={14} aria-hidden="true" />
        </button>
        {open && <SourceConstellation id={id} sources={sources} vaultHref={vaultHref} cosmosHref={cosmosHref} />}
    </>;
}

function SourceConstellation({ id, sources, vaultHref, cosmosHref }: {
    id: string;
    sources: ReplySource[];
    vaultHref: (path: string) => string;
    cosmosHref?: string;
}) {
    const [active, setActive] = useState<number | null>(null);
    const nodes = layout(sources);
    const trail = nodes.map((node, index) => `${index ? "L" : "M"}${node.x} ${node.y}`).join("");
    const lit = active === null ? "" : nodes
        .filter((_, index) => Math.abs(index - active) <= 1)
        .map((node, index) => `${index ? "L" : "M"}${node.x} ${node.y}`).join("");

    return <figure id={id} className={ui.recall} aria-label="Sources this reply drew on">
        <svg className={ui.sky} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Constellation of ${plural(sources.length, "source")}, sized by contribution`}>
            <rect className={ui.frame} x=".5" y=".5" width={WIDTH - 1} height={HEIGHT - 1} rx="6" />
            <path className={ui.tick} d="M60 1v4M120 1v4M180 1v4M240 1v4M60 87v4M120 87v4M180 87v4M240 87v4M1 31h4M1 61h4M295 31h4M295 61h4" />
            <path className={ui.grat} d="M8 78C96 66 204 66 292 78" />
            <path className={ui.grat} d="M226 6C221 32 221 60 226 86" />
            {nodes.length > 1 && <path className={ui.link} d={trail} />}
            {lit && <path className={ui.link} data-on d={lit} />}
            {nodes.map((node, index) => <g key={index}>
                <circle className={ui.knockout} cx={node.x} cy={node.y} r={node.r + (active === index ? 6 : 2.6)} />
                {active === index && <circle className={ui.ring} cx={node.x} cy={node.y} r={node.r + 4} />}
                <circle cx={node.x} cy={node.y} r={node.r} fill={sourceColour(node.source)} />
                <text className={ui.number} data-on={active === index || undefined} x={node.x} y={node.above ? node.y - node.r - 9 : node.y + node.r + 16} textAnchor="middle">{index + 1}</text>
            </g>)}
        </svg>
        <div className={ui.filed}>
            <ol className={ui.list}>
                {nodes.map(({ source }, index) => {
                    const { kind, text } = sourceText(source);
                    const body = <>
                        <span className={ui.n}>{index + 1}</span>
                        <span className={ui.dot} style={{ background: sourceColour(source) }} aria-hidden="true" />
                        <span className={ui.text}><span className={ui.kind}>{kind},</span> {text}</span>
                    </>;
                    const hover = { onMouseEnter: () => setActive(index), onMouseLeave: () => setActive(null) };
                    return <li key={index}>
                        {source.kind === "vault" && source.ref
                            ? <a className={ui.item} href={vaultHref(source.ref)} {...hover} onFocus={() => setActive(index)} onBlur={() => setActive(null)}>{body}</a>
                            : <span className={ui.item} data-static {...hover}>{body}</span>}
                    </li>;
                })}
            </ol>
            {cosmosHref && <a className={ui.cosmos} href={cosmosHref}>Open in Cosmos<ArrowUpRight size={14} aria-hidden="true" /></a>}
        </div>
    </figure>;
}
