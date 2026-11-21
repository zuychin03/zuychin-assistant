import type { ModelDataClass } from "@/lib/ai/data-policy";
import type { CouncilMessage } from "@/lib/council/store";
import {
    RESEARCH_NOTE_EXCERPT_CHARS, RESEARCH_NOTES, RESEARCH_PACK_CHARS, RESEARCH_QUERY_CHARS, RESEARCH_SOURCE_TIMEOUT_MS,
    RESEARCH_TITLE_CHARS, RESEARCH_VAULT_PAGES, RESEARCH_WEB_EXCERPT_CHARS, RESEARCH_WEB_RESULTS,
} from "./limits";

// Research first: the server searches once before round 1 and posts the results
// as one moderator message. Seats never get a tool. Pure on purpose: the
// /council page imports the marker, and the searches arrive as deps.

export const RESEARCH_MARKER = "Sources gathered before round 1";
export const RESEARCH_CLIENT_KEY = "research:pack";

export interface ResearchRequest {
    web: boolean;
    notes: boolean;
    query?: string;
}

export interface WebHit { title: string; url: string; content: string }
export interface NoteHit { content: string; category?: string }
export interface VaultHit { path: string; title: string; summary: string }

export interface ResearchDeps {
    /** null when no Tavily pool could answer; "unconfigured" when no key is set. */
    searchWeb(query: string): Promise<WebHit[] | null | "unconfigured">;
    /** Saved notes only, never chat messages. */
    searchNotes(query: string): Promise<NoteHit[]>;
    /** null when the vault is not configured. */
    searchVault(query: string): Promise<VaultHit[] | null>;
}

export type SourceKind = "web" | "note" | "vault";

export interface ResearchSource {
    marker: string;
    kind: SourceKind;
    title: string;
    link?: string;
}

/** What the start result reports back to the panel, the card and chat. */
export interface ResearchSummary {
    web: number;
    notes: number;
    vault: number;
    problems: string[];
}

export function describeResearch(summary: ResearchSummary | undefined): string {
    if (!summary) return "";
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const found = [
        summary.web ? plural(summary.web, "web source", "web sources") : "",
        summary.notes ? plural(summary.notes, "note", "notes") : "",
        summary.vault ? plural(summary.vault, "vault page", "vault pages") : "",
    ].filter(Boolean);
    const problems = summary.problems.length ? ` ${summary.problems.join(" ")}` : "";
    return found.length ? `Sources: ${found.join(", ")}.${problems}` : `No sources were posted.${problems}`;
}

export interface ResearchPack {
    query: string;
    /** Empty when no source returned anything; nothing is posted then. */
    body: string;
    sources: ResearchSource[];
    problems: string[];
}

const PREFIX: Record<SourceKind, string> = { web: "W", note: "N", vault: "V" };
const KIND_BY_PREFIX: Record<string, SourceKind> = { W: "web", N: "note", V: "vault" };
const HEADER = /^\[([WNV])(\d+)\] (.+)$/;

function oneLine(text: string): string {
    return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/<<<|>>>/g, "").replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
    const line = oneLine(text);
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function webUrl(raw: string): string | null {
    try {
        const url = new URL(raw.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString().slice(0, 500) : null;
    } catch {
        return null;
    }
}

// Same value as NOTE_SOURCE in src/lib/db.ts. The knowledge search also returns
// chat messages and generated documents; only saved notes may reach a seat.
const SAVED_NOTE_SOURCE = "mcp_save_note";

export function savedNotesOnly(rows: readonly { content: string; metadata?: Record<string, string> }[]): NoteHit[] {
    return rows.filter((row) => row.metadata?.source === SAVED_NOTE_SOURCE && !row.metadata?.conversationId)
        .map((row) => ({ content: row.content, ...(row.metadata?.category ? { category: row.metadata.category } : {}) }));
}

/** From an API body or chat tool arguments. Anything malformed is off. */
export function readResearchRequest(raw: unknown): ResearchRequest | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    const web = r.web === true;
    const notes = r.notes === true;
    if (!web && !notes) return undefined;
    const query = typeof r.query === "string" ? clip(r.query, RESEARCH_QUERY_CHARS) : "";
    return { web, notes, ...(query ? { query } : {}) };
}

const TIMED_OUT = Symbol("timed out");
const FAILED = Symbol("failed");
const SKIPPED = Symbol("skipped");
type Outcome<T> = T | typeof TIMED_OUT | typeof FAILED | typeof SKIPPED;

async function within<T>(work: () => Promise<T>, ms: number): Promise<Outcome<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
    try {
        return await Promise.race([work().catch((): typeof FAILED => FAILED), limit]);
    } finally {
        clearTimeout(timer);
    }
}

interface Block { kind: SourceKind; title: string; link?: string; lines: string[] }

function webBlocks(hits: readonly WebHit[]): Block[] {
    return hits.flatMap((hit) => {
        const url = webUrl(hit.url);
        if (!url) return [];
        return [{ kind: "web" as const, title: clip(hit.title || url, RESEARCH_TITLE_CHARS), link: url, lines: [`Link: ${url}`, `> ${clip(hit.content, RESEARCH_WEB_EXCERPT_CHARS)}`] }];
    }).slice(0, RESEARCH_WEB_RESULTS);
}

function noteBlocks(hits: readonly NoteHit[]): Block[] {
    return hits.filter((hit) => oneLine(hit.content)).slice(0, RESEARCH_NOTES).map((hit) => ({
        kind: "note" as const,
        title: `Saved note${hit.category ? ` (${clip(hit.category, 40)})` : ""}`,
        lines: [`> ${clip(hit.content, RESEARCH_NOTE_EXCERPT_CHARS)}`],
    }));
}

// Vault search ranks sections, so one page can fill every slot; keep its best section.
function vaultBlocks(hits: readonly VaultHit[]): Block[] {
    const seen = new Set<string>();
    const pages = hits.filter((hit) => {
        const path = oneLine(hit.path);
        if (!path || seen.has(path)) return false;
        seen.add(path);
        return true;
    });
    return pages.slice(0, RESEARCH_VAULT_PAGES).map((hit) => {
        const path = clip(hit.path, 200);
        return { kind: "vault" as const, title: clip(hit.title || path, RESEARCH_TITLE_CHARS), link: path, lines: [`Vault page: ${path}`, `> ${clip(hit.summary, RESEARCH_NOTE_EXCERPT_CHARS)}`] };
    });
}

function blockText(block: Block, marker: string): string {
    return [`[${marker}] ${block.title}`, ...block.lines].join("\n");
}

/** Runs the asked searches in parallel. A failed or slow source becomes a problem line, never an error. */
export async function gatherResearch(
    input: { topic: string; request: ResearchRequest; freeOnly: boolean },
    deps: ResearchDeps,
    timeoutMs = RESEARCH_SOURCE_TIMEOUT_MS,
): Promise<ResearchPack> {
    const query = input.request.query ? clip(input.request.query, RESEARCH_QUERY_CHARS) : clip(input.topic, RESEARCH_QUERY_CHARS);
    const seconds = Math.round(timeoutMs / 1000);
    const [web, notes, vault] = await Promise.all([
        input.request.web ? within(() => deps.searchWeb(query), timeoutMs) : SKIPPED,
        input.request.notes ? within(() => deps.searchNotes(query), timeoutMs) : SKIPPED,
        input.request.notes && !input.freeOnly ? within(() => deps.searchVault(query), timeoutMs) : SKIPPED,
    ]);

    const problems: string[] = [];
    let blocks: Block[] = [];
    if (web === TIMED_OUT) problems.push(`Web search took longer than ${seconds} s.`);
    else if (web === FAILED) problems.push("Web search failed.");
    else if (web === "unconfigured") problems.push("Web search is not configured (no Tavily key).");
    else if (web === null) problems.push("Web search was unavailable (Tavily refused the request or is out of credits).");
    else if (Array.isArray(web)) {
        const found = webBlocks(web);
        if (found.length === 0) problems.push(`Web search found nothing for "${query}".`);
        blocks = blocks.concat(found);
    }
    if (notes === TIMED_OUT) problems.push(`Notes search took longer than ${seconds} s.`);
    else if (notes === FAILED) problems.push("Notes search failed.");
    else if (Array.isArray(notes)) {
        const found = noteBlocks(notes);
        if (found.length === 0) problems.push("No saved notes matched.");
        blocks = blocks.concat(found);
    }
    if (input.request.notes && input.freeOnly) problems.push("Vault pages were skipped because Free only is on.");
    else if (vault === TIMED_OUT) problems.push(`Vault search took longer than ${seconds} s.`);
    else if (vault === FAILED) problems.push("Vault search failed.");
    else if (Array.isArray(vault)) blocks = blocks.concat(vaultBlocks(vault));

    const header = `${RESEARCH_MARKER} for "${query}".`;
    const footer = problems.length ? `Not available: ${problems.join(" ")}` : "";
    // Taken in turns across kinds, so a full page of web results cannot crowd out the notes.
    const queues = (["web", "note", "vault"] as const).map((kind) => blocks.filter((b) => b.kind === kind));
    const chosen = new Set<Block>();
    let used = header.length + (footer ? footer.length + 2 : 0);
    for (let round = 0; queues.some((q) => q.length > round); round++) {
        for (const queue of queues) {
            const block = queue[round];
            if (!block) continue;
            const size = blockText(block, "X99").length + 2;
            if (used + size > RESEARCH_PACK_CHARS) continue;
            chosen.add(block);
            used += size;
        }
    }

    const sources: ResearchSource[] = [];
    const parts: string[] = [];
    const counts: Record<SourceKind, number> = { web: 0, note: 0, vault: 0 };
    for (const block of blocks.filter((b) => chosen.has(b))) {
        const marker = `${PREFIX[block.kind]}${++counts[block.kind]}`;
        sources.push({ marker, kind: block.kind, title: block.title, ...(block.link ? { link: block.link } : {}) });
        parts.push(blockText(block, marker));
    }
    const body = sources.length ? [header, ...parts, ...(footer ? [footer] : [])].join("\n\n") : "";
    return { query, body, sources, problems };
}

/** The pack is the round-1 moderator message carrying the marker; only the server writes moderator messages. */
export function findResearchPack(messages: readonly CouncilMessage[]): CouncilMessage | undefined {
    return messages.find((m) => m.role === "moderator" && m.round === 1 && m.body.startsWith(RESEARCH_MARKER));
}

/** Reads the sources back from a posted pack, so a restarted runner needs nothing but the transcript. */
export function parsePackSources(body: string | undefined): ResearchSource[] {
    if (!body) return [];
    const lines = body.split("\n");
    const sources: ResearchSource[] = [];
    lines.forEach((line, i) => {
        const header = HEADER.exec(line);
        if (!header) return;
        const next = lines[i + 1] ?? "";
        const link = next.startsWith("Link: ") ? next.slice(6) : next.startsWith("Vault page: ") ? next.slice(12) : undefined;
        sources.push({ marker: `${header[1]}${header[2]}`, kind: KIND_BY_PREFIX[header[1]], title: header[3], ...(link ? { link } : {}) });
    });
    return sources;
}

/** Data classes for a seat call that carries the pack; undefined keeps the plain call unchanged. */
export function researchClasses(messages: readonly CouncilMessage[]): ModelDataClass[] | undefined {
    const sources = parsePackSources(findResearchPack(messages)?.body);
    if (sources.length === 0) return undefined;
    return [
        "personal",
        ...(sources.some((s) => s.kind !== "web") ? ["knowledge" as const] : []),
        ...(sources.some((s) => s.kind === "web") ? ["public_search" as const] : []),
    ];
}

/** Links for the markers a verdict cites, written by code so a model never invents a URL. */
export function citedSourcesFooter(verdict: string, sources: readonly ResearchSource[]): string {
    const known = new Map(sources.map((s) => [s.marker, s]));
    const cited: string[] = [];
    for (const group of verdict.matchAll(/\[([WNV]\d+(?:\s*,\s*[WNV]\d+)*)\]/g)) {
        for (const marker of group[1].split(",").map((m) => m.trim())) {
            if (known.has(marker) && !cited.includes(marker)) cited.push(marker);
        }
    }
    if (cited.length === 0) return "";
    const lines = cited.map((marker) => {
        const source = known.get(marker)!;
        return `- [${marker}] ${source.title}${source.link ? `: ${source.link}` : ""}`;
    });
    return `\n\n**Sources cited**\n${lines.join("\n")}`;
}
