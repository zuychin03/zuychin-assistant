"use client";

import { useId, useState } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { ReplySource, ReplyTrace } from "@/lib/ai/reply-trace";
import { ReplyTraceBody, validTrace } from "./reply-trace";
import ui from "./reply-sources.module.css";

const TOOLS: Record<string, { service: string; action: string; activity: string }> = {
    list_calendar_events: { service: "Calendar", action: "checked events", activity: "Checked Calendar" },
    manage_calendar_event: { service: "Calendar", action: "updated an event", activity: "Updated Calendar" },
    list_unread_emails: { service: "Gmail", action: "checked unread mail", activity: "Checked Gmail" },
    list_recent_emails: { service: "Gmail", action: "checked recent mail", activity: "Checked Gmail" },
    read_email: { service: "Gmail", action: "read an email", activity: "Read Gmail" },
    send_email: { service: "Gmail", action: "sent an email", activity: "Sent an email" },
    draft_gmail_reply: { service: "Gmail", action: "drafted a reply", activity: "Drafted a reply" },
    manage_todo_list: { service: "To-do", action: "updated the list", activity: "Updated to-dos" },
    search_knowledge: { service: "Memory", action: "searched", activity: "Searched memory" },
    save_note: { service: "Notes", action: "saved a note", activity: "Saved a note" },
    get_recent_conversations: { service: "Chats", action: "reviewed recent chats", activity: "Reviewed recent chats" },
    get_current_time: { service: "Clock", action: "checked the time", activity: "Checked the time" },
    create_document: { service: "Files", action: "wrote a document", activity: "Wrote a document" },
    create_code_file: { service: "Files", action: "wrote a code file", activity: "Wrote a code file" },
    create_code_bundle: { service: "Files", action: "bundled files", activity: "Bundled files" },
    use_skill: { service: "Skill", action: "consulted a skill", activity: "Used a skill" },
    vault_search: { service: "Vault", action: "searched", activity: "Searched the vault" },
    vault_read: { service: "Vault", action: "read a page", activity: "Read the vault" },
    vault_ingest: { service: "Vault", action: "saved a page", activity: "Saved to the vault" },
    vault_write: { service: "Vault", action: "updated a page", activity: "Updated the vault" },
    vault_lint: { service: "Vault", action: "tidied pages", activity: "Tidied the vault" },
    search_web: { service: "Web", action: "searched", activity: "Searched the web" },
};

const toolInfo = (name: string) => TOOLS[name] ?? { service: name.replaceAll("_", " "), action: "used", activity: `Used ${name.replaceAll("_", " ")}` };
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

export function SourceChart({ sources, vaultHref, cosmosHref }: {
    sources: ReplySource[];
    vaultHref: (path: string) => string;
    cosmosHref?: string;
}) {
    const [active, setActive] = useState<number | null>(null);
    if (!sources.length) return null;
    const nodes = layout(sources);
    const trail = nodes.map((node, index) => `${index ? "L" : "M"}${node.x} ${node.y}`).join("");
    const lit = active === null ? "" : nodes
        .filter((_, index) => Math.abs(index - active) <= 1)
        .map((node, index) => `${index ? "L" : "M"}${node.x} ${node.y}`).join("");

    return <figure className={ui.recall} aria-label="Sources this reply drew on">
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
