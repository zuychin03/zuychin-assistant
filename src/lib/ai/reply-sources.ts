import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplyRanking, ReplySource } from "@/lib/ai/reply-trace";
import type { UntrustedSource } from "@/lib/ai/reply-notes";

const MAX_SOURCES = 8;
const MAX_RANKINGS = 6;
const MAX_FETCHED = 6;
const FETCHED_CHARS = 2_000;
const LABEL_LIMIT = 120;

/** Outside text a tool brought into the turn, for the memory gate's injection question. */
export interface FetchedContent { source: UntrustedSource; text: string }

const scope = new AsyncLocalStorage<{ sources: ReplySource[]; asked: Set<string>; rankings: ReplyRanking[]; fetched: FetchedContent[] }>();

export function withReplySources<T>(sources: ReplySource[], fn: () => T, asked = new Set<string>(), rankings: ReplyRanking[] = []): T {
    return scope.run({ sources, asked, rankings, fetched: [] }, fn);
}

// Tools whose results carry text written by someone other than the owner.
const FETCHED_SOURCES: Record<string, UntrustedSource> = {
    search_web: "search results", list_unread_emails: "emails", list_recent_emails: "emails", read_email: "emails", list_calendar_events: "calendar events",
};

export function recordFetchedContent(tool: string, result: string) {
    const fetched = scope.getStore()?.fetched;
    const source = FETCHED_SOURCES[tool];
    const text = result.trim();
    if (!fetched || !source || !text || fetched.length >= MAX_FETCHED) return;
    fetched.push({ source, text: text.slice(0, FETCHED_CHARS) });
}

/** What tools fetched so far in this turn; read it inside the turn, since background work runs outside it. */
export function fetchedContent(): FetchedContent[] {
    return [...(scope.getStore()?.fetched ?? [])];
}

export function recordReplyRanking(ranking: ReplyRanking) {
    const rankings = scope.getStore()?.rankings;
    if (rankings && rankings.length < MAX_RANKINGS) rankings.push(ranking);
}

/** A tool call that waited for the owner's approval, or was refused, instead of running. */
export function recordAskedTool(name: string) {
    scope.getStore()?.asked.add(name);
}

const clip = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 1)}…` : text;
};

export function recordReplySources(items: ReplySource[]) {
    const sources = scope.getStore()?.sources;
    if (!sources) return;
    for (const item of items) {
        const label = clip(item.label);
        if (!label) continue;
        const weight = Number.isFinite(item.weight) ? Math.min(1, Math.max(0, item.weight)) : 0.5;
        const key = `${item.kind}:${item.ref ?? label}`;
        const existing = sources.find((source) => `${source.kind}:${source.ref ?? source.label}` === key);
        if (existing) existing.weight = Math.max(existing.weight, weight);
        else sources.push({ ...item, label, ...(item.detail ? { detail: clip(item.detail) } : {}), weight });
    }
}

export function rankReplySources(sources: ReplySource[]): ReplySource[] | undefined {
    if (!sources.length) return undefined;
    return [...sources].sort((a, b) => b.weight - a.weight).slice(0, MAX_SOURCES);
}
