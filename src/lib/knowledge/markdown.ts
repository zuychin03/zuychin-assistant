import { createHash, randomUUID } from "node:crypto";
import type {
    KnowledgeDocumentMeta, KnowledgeKind, KnowledgeScope, KnowledgeSensitivity,
    KnowledgeStatus, KnowledgeTrust,
} from "@/lib/knowledge/types";

export interface FrontmatterDocument {
    attributes: Record<string, string | string[]>;
    body: string;
    rawFrontmatter?: string[];
}

const ARRAY_VALUE = /^\[(.*)]$/;

export function hashContent(content: string): string {
    return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

export function newKnowledgeId(): string {
    return `zuychin-${randomUUID()}`;
}

export function parseFrontmatter(markdown: string): FrontmatterDocument {
    const normalized = markdown.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return { attributes: {}, body: normalized };
    const end = normalized.indexOf("\n---\n", 4);
    if (end === -1) return { attributes: {}, body: normalized };

    const attributes: Record<string, string | string[]> = {};
    const rawFrontmatter = normalized.slice(4, end).split("\n");
    for (let index = 0; index < rawFrontmatter.length; index++) {
        const line = rawFrontmatter[index];
        const field = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
        if (!field) continue;
        const [, key, rawValue = ""] = field;
        const value = rawValue.trim();
        const inlineArray = value.match(ARRAY_VALUE);
        if (inlineArray) {
            attributes[key] = inlineArray[1]
                .split(",")
                .map((item) => unquote(item.trim()))
                .filter(Boolean);
            continue;
        }
        if (value) {
            attributes[key] = unquote(value);
            continue;
        }

        const items: string[] = [];
        for (let child = index + 1; child < rawFrontmatter.length; child++) {
            if (/^[A-Za-z0-9_-]+:/.test(rawFrontmatter[child])) break;
            const item = rawFrontmatter[child].match(/^\s+-\s+(.+)$/);
            if (item) items.push(unquote(item[1].trim()));
        }
        attributes[key] = items.length ? items : "";
    }
    return {
        attributes,
        body: normalized.slice(end + 5),
        rawFrontmatter,
    };
}

function unquote(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

function quoteValue(value: string): string {
    if (!value || /[:#[\]{},&*!|>'"%@`\n]/.test(value) || /^[-?]\s/.test(value)) {
        return JSON.stringify(value);
    }
    return value;
}

function formatAttribute(value: string | string[]): string {
    if (Array.isArray(value)) return `[${value.map(quoteValue).join(", ")}]`;
    return quoteValue(value);
}

export function serializeFrontmatter(document: FrontmatterDocument): string {
    const preferred = [
        "zuychin_id", "title", "category", "type", "scope", "status", "trust",
        "sensitivity", "project_id", "supersedes", "valid_from", "valid_to",
        "created", "updated", "sources", "tags",
    ];
    const managed = new Set(preferred);
    const raw = document.rawFrontmatter ?? [];
    const rawKeys = new Set<string>();
    const passthrough: string[] = [];

    for (let index = 0; index < raw.length;) {
        const field = raw[index].match(/^([A-Za-z0-9_-]+):/);
        if (!field) {
            passthrough.push(raw[index]);
            index++;
            continue;
        }
        const start = index;
        const key = field[1];
        rawKeys.add(key);
        index++;
        while (index < raw.length && !/^[A-Za-z0-9_-]+:/.test(raw[index])) index++;
        if (!managed.has(key)) passthrough.push(...raw.slice(start, index));
    }

    const keys = [
        ...preferred.filter((key) => document.attributes[key] !== undefined),
        ...Object.keys(document.attributes)
            .filter((key) => !managed.has(key) && !rawKeys.has(key))
            .sort(),
    ];
    const generated = keys.map((key) => `${key}: ${formatAttribute(document.attributes[key])}`);
    const yaml = [...generated, ...passthrough].join("\n").trimEnd();
    return `---\n${yaml}\n---\n\n${document.body.replace(/^\n+/, "")}`;
}

function asString(value: string | string[] | undefined, fallback = ""): string {
    return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback;
}

function asArray(value: string | string[] | undefined): string[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function titleFromBody(body: string, path: string): string {
    return body.match(/^#\s+(.+)$/m)?.[1].trim()
        ?? path.split("/").pop()?.replace(/\.md$/i, "").replace(/-/g, " ")
        ?? "Untitled";
}

export function normalizeVaultMarkdown(params: {
    path: string;
    markdown: string;
    title?: string;
    category?: string;
    summary?: string;
    kind?: KnowledgeKind;
    scope?: KnowledgeScope;
    status?: KnowledgeStatus;
    trust?: KnowledgeTrust;
    sensitivity?: KnowledgeSensitivity;
    source?: string;
}): { markdown: string; meta: KnowledgeDocumentMeta } {
    const parsed = parseFrontmatter(params.markdown);
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const id = asString(parsed.attributes.zuychin_id) || newKnowledgeId();
    const title = params.title || asString(parsed.attributes.title) || titleFromBody(parsed.body, params.path);
    const category = params.category || asString(parsed.attributes.category, "concepts");
    const kind = params.kind || asString(parsed.attributes.type, category === "sources" ? "document" : "semantic") as KnowledgeKind;
    const scope = params.scope || asString(parsed.attributes.scope, "user") as KnowledgeScope;
    const status = params.status || asString(parsed.attributes.status, "active") as KnowledgeStatus;
    const trust = params.trust || asString(parsed.attributes.trust, "reviewed") as KnowledgeTrust;
    const sensitivity = params.sensitivity || asString(parsed.attributes.sensitivity, "private") as KnowledgeSensitivity;
    const createdAt = asString(parsed.attributes.created, today);
    const updatedAt = today;
    const sources = asArray(parsed.attributes.sources);
    if (params.source && !sources.includes(params.source)) sources.push(params.source);

    parsed.attributes = {
        ...parsed.attributes,
        zuychin_id: id,
        title,
        category,
        type: kind,
        scope,
        status,
        trust,
        sensitivity,
        created: createdAt,
        updated: updatedAt,
    };
    if (sources.length) parsed.attributes.sources = sources;

    const normalizedMarkdown = serializeFrontmatter(parsed);
    const contentHash = hashContent(normalizedMarkdown);
    return {
        markdown: normalizedMarkdown,
        meta: {
            id,
            path: params.path,
            title,
            summary: params.summary ?? "",
            category,
            kind,
            scope,
            status,
            trust,
            sensitivity,
            projectId: asString(parsed.attributes.project_id) || undefined,
            supersedesId: asString(parsed.attributes.supersedes) || undefined,
            validFrom: asString(parsed.attributes.valid_from) || undefined,
            validTo: asString(parsed.attributes.valid_to) || undefined,
            createdAt,
            updatedAt,
            contentHash,
            provenance: sources.map((source) => ({
                source,
                ...(source.startsWith("http") ? { sourceUrl: source } : { sourcePath: source }),
                capturedAt: now,
                contentHash,
            })),
        },
    };
}
