import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplySource } from "@/lib/ai/reply-trace";

const MAX_SOURCES = 8;
const LABEL_LIMIT = 120;
const scope = new AsyncLocalStorage<ReplySource[]>();

export function withReplySources<T>(sources: ReplySource[], fn: () => T): T {
    return scope.run(sources, fn);
}

const clip = (value: string) => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 1)}…` : text;
};

export function recordReplySources(items: ReplySource[]) {
    const sources = scope.getStore();
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
