import { ai, MODEL } from "@/lib/gemini";
import { Type, ThinkingLevel } from "@google/genai";
import {
    commitFiles, getFile, requireVaultConfig,
    type CommitFileChange,
} from "@/lib/vault/github";
import { searchVaultPages, upsertVaultPage, type VaultPageHit } from "@/lib/vault/store";
import { withVaultLock } from "@/lib/vault/lock";
import type { ResolvedEmbedding } from "@/lib/ai/embeddings";

// Auto-link proposal: pgvector proposes generously, the LLM curator selects
// (agents.md INGEST step 3). Measured doc↔doc cosines (Nemotron embeddings):
// same topic 0.7–0.8, related cross-topic 0.45–0.6, unrelated <0.4 — the
// threshold only cuts noise.
const LINK_THRESHOLD = 0.4;
const MAX_LINK_CANDIDATES = 6;

export const VAULT_CATEGORIES = ["sources", "concepts", "entities", "synthesis"] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

function slugify(title: string): string {
    return title
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || "untitled";
}

export function today(): string {
    return new Date().toISOString().slice(0, 10);
}

/** Wikilink form of a repo path: no .md extension. */
export function toWikilink(path: string): string {
    return path.replace(/\.md$/, "");
}

const PAGE_CONVENTIONS = `Every wiki page starts with YAML frontmatter:
---
title: <Human-readable title>
category: sources | concepts | entities | synthesis
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [<raw file path or URL>]   # only for sources/synthesis pages
---

Then "# <Title>" and the body. Link related pages with labelled [[wikilinks]] using the path WITHOUT .md, e.g. "extends [[wiki/concepts/attention]]". Keep claims cited. Write durable, self-contained knowledge — not chat transcripts.`;

interface AuthoredPage {
    markdown: string;
    summary: string;
    links: { path: string; label: string }[];
}

async function authorPage(params: {
    title: string;
    category: VaultCategory;
    pagePath: string;
    rawPath?: string;
    source?: string;
    content: string;
    existing?: string;
    candidates: VaultPageHit[];
}): Promise<AuthoredPage> {
    const candidateBlock = params.candidates.length
        ? params.candidates
            .map((c) => `- ${c.path} (${c.category}, sim ${c.similarity.toFixed(2)}): ${c.title} — ${c.summary}`)
            .join("\n")
        : "(none)";

    const prompt = `You are the librarian of a personal knowledge vault (Karpathy LLM-Wiki style). Author ONE wiki page in Markdown.

${PAGE_CONVENTIONS}

Page to write:
- path: ${params.pagePath}
- title: ${params.title}
- category: ${params.category}
- date: ${today()}
${params.rawPath ? `- sources frontmatter must include: ${params.rawPath}` : ""}
${params.source ? `- original source (cite it): ${params.source}` : ""}

${params.existing ? `An earlier version of this page exists. MERGE the new material into it — keep everything still true, update what changed, bump "updated:". Earlier version:\n"""\n${params.existing.slice(0, 12000)}\n"""\n` : ""}
Material to distil into the page:
"""
${params.content.slice(0, 30000)}
"""

Semantically similar existing pages (auto-link candidates). Link ONLY genuine relationships — extends, contradicts, example-of, part-of, uses — and discard weak or coincidental matches:
${candidateBlock}

Return JSON:
- markdown: the complete page (frontmatter + body). Weave labelled [[wikilinks]] to each confirmed candidate into the body where relevant.
- summary: one line (< 140 chars) for the index catalogue.
- links: the confirmed candidates only, as {path (exactly as listed), label (the relationship)}.`;

    const resp = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    markdown: { type: Type.STRING },
                    summary: { type: Type.STRING },
                    links: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                path: { type: Type.STRING },
                                label: { type: Type.STRING },
                            },
                            required: ["path", "label"],
                        },
                    },
                },
                required: ["markdown", "summary", "links"],
            },
        },
    });

    const parsed = JSON.parse(resp.text ?? "{}") as Partial<AuthoredPage>;
    if (!parsed.markdown || !parsed.summary) {
        throw new Error("Page author returned an incomplete result.");
    }
    const allowed = new Set(params.candidates.map((c) => c.path));
    return {
        markdown: parsed.markdown,
        summary: parsed.summary.replace(/\s+/g, " ").trim(),
        links: (parsed.links ?? []).filter((l) => l?.path && allowed.has(l.path)),
    };
}

/** Independent verify-before-commit gate (agents.md INGEST step 6). Fails closed. */
async function verifyPage(params: {
    content: string;
    markdown: string;
    touchedPaths: string[];
}): Promise<{ pass: boolean; reason: string }> {
    const prompt = `You are an independent verifier for a knowledge-vault commit. Check the authored wiki page against the source material.

Fail it only for real problems:
1. Claims in the page that the source material does not support (fabrication).
2. Missing or malformed YAML frontmatter (title, category, created, updated).
3. The page is empty, truncated, or clearly not a knowledge page.
Style, brevity, and judgement calls are NOT failures.

Source material:
"""
${params.content.slice(0, 20000)}
"""

Authored page:
"""
${params.markdown.slice(0, 20000)}
"""

Files in this commit: ${params.touchedPaths.join(", ")}

Return JSON {pass: boolean, reason: string} — reason is one short sentence.`;

    const resp = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    pass: { type: Type.BOOLEAN },
                    reason: { type: Type.STRING },
                },
                required: ["pass", "reason"],
            },
        },
    });
    const parsed = JSON.parse(resp.text ?? "{}") as { pass?: boolean; reason?: string };
    return { pass: parsed.pass === true, reason: parsed.reason ?? "Verifier returned no reason." };
}

/** Add a labelled back-reference to a linked page, so links stay bidirectional. */
export function addBacklink(targetMarkdown: string, newPageLink: string, label: string): string | null {
    if (targetMarkdown.includes(`[[${newPageLink}]]`)) return null;

    let updated = targetMarkdown.replace(/^updated: .*$/m, `updated: ${today()}`);
    const line = `- ${label} [[${newPageLink}]]`;
    if (/^## Related\s*$/m.test(updated)) {
        updated = updated.replace(/^## Related\s*$/m, `## Related\n\n${line}`);
    } else {
        updated = `${updated.trimEnd()}\n\n## Related\n\n${line}\n`;
    }
    return updated;
}

const CATEGORY_HEADING: Record<VaultCategory, string> = {
    sources: "## Sources",
    concepts: "## Concepts",
    entities: "## Entities",
    synthesis: "## Synthesis",
};

/** Insert or update this page's one-line entry under its category heading in index.md. */
export function updateIndex(indexMarkdown: string, category: VaultCategory, pagePath: string, summary: string): string {
    const link = toWikilink(pagePath);
    const entry = `- [[${link}]] — ${summary}`;
    const heading = CATEGORY_HEADING[category];

    const lines = indexMarkdown.split("\n");
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start === -1) {
        return `${indexMarkdown.trimEnd()}\n\n${heading}\n\n${entry}\n`;
    }

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].startsWith("## ")) { end = i; break; }
    }

    const existing = lines.findIndex(
        (l, i) => i > start && i < end && l.includes(`[[${link}]]`),
    );
    if (existing !== -1) {
        lines[existing] = entry;
        return lines.join("\n");
    }

    const placeholder = lines.findIndex(
        (l, i) => i > start && i < end && l.trim() === "_(none yet)_",
    );
    if (placeholder !== -1) {
        lines[placeholder] = entry;
        return lines.join("\n");
    }

    // Append after the section's last non-empty line.
    let insertAt = start + 1;
    for (let i = start + 1; i < end; i++) {
        if (lines[i].trim() !== "") insertAt = i + 1;
    }
    if (insertAt === start + 1) {
        lines.splice(insertAt, 0, "", entry);
    } else {
        lines.splice(insertAt, 0, entry);
    }
    return lines.join("\n");
}

export function appendLog(logMarkdown: string, action: string, title: string): string {
    return `${logMarkdown.trimEnd()}\n\n## [${today()}] ${action} | ${title}\n`;
}

export interface IngestResult {
    pagePath: string;
    commit: string;
    summary: string;
    links: { path: string; label: string }[];
    updatedExisting: boolean;
}

/**
 * Full INGEST pipeline from agents.md: raw capture → authored wiki page →
 * pgvector-proposed / LLM-curated bidirectional links → index + log →
 * verify gate → one atomic `learn:` commit → pgvector index refresh.
 */
export async function ingestToVault(params: {
    title: string;
    content: string;
    category?: VaultCategory;
    source?: string;
    embRef: ResolvedEmbedding;
}): Promise<IngestResult> {
    return withVaultLock(async () => {
        const cfg = requireVaultConfig();
        const category: VaultCategory = params.category && VAULT_CATEGORIES.includes(params.category)
            ? params.category
            : "sources";
        const slug = slugify(params.title);
        const pagePath = `wiki/${category}/${slug}.md`;
        const rawPath = `raw/${today()}-${slug}.md`;

        const existing = await getFile(cfg, pagePath);

        // Propose link candidates from the semantic index (excluding the page itself).
        const candidates = (
            await searchVaultPages({
                query: `${params.title}\n\n${params.content.slice(0, 4000)}`,
                embRef: params.embRef,
                matchThreshold: LINK_THRESHOLD,
                matchCount: MAX_LINK_CANDIDATES + 1,
                inputType: "passage",
            })
        ).filter((c) => c.path !== pagePath).slice(0, MAX_LINK_CANDIDATES);

        const authored = await authorPage({
            title: params.title,
            category,
            pagePath,
            rawPath: existing ? undefined : rawPath,
            source: params.source,
            content: params.content,
            existing: existing?.text,
            candidates,
        });

        const changes: CommitFileChange[] = [];
        const backlinked: VaultPageHit[] = [];

        // Immutable raw capture — only on first ingest of this page.
        if (!existing) {
            changes.push({
                path: rawPath,
                content: `# ${params.title} (raw)\n\nSource: ${params.source ?? "provided in conversation"}\nCaptured: ${today()}\n\n---\n\n${params.content}\n`,
            });
        }
        changes.push({ path: pagePath, content: authored.markdown });

        const backlinkContent = new Map<string, string>();
        for (const link of authored.links) {
            const hit = candidates.find((c) => c.path === link.path);
            if (!hit) continue;
            const target = await getFile(cfg, link.path);
            if (!target) continue;
            const updated = addBacklink(target.text, toWikilink(pagePath), link.label);
            if (updated) {
                changes.push({ path: link.path, content: updated });
                backlinkContent.set(link.path, updated);
                backlinked.push(hit);
            }
        }

        const [indexFile, logFile] = await Promise.all([
            getFile(cfg, "index.md"),
            getFile(cfg, "log.md"),
        ]);
        changes.push({
            path: "index.md",
            content: updateIndex(indexFile?.text ?? "# Index\n", category, pagePath, authored.summary),
        });
        changes.push({
            path: "log.md",
            content: appendLog(logFile?.text ?? "# Log\n", "ingest", params.title),
        });

        const verdict = await verifyPage({
            content: params.content,
            markdown: authored.markdown,
            touchedPaths: changes.map((c) => c.path),
        });
        if (!verdict.pass) {
            throw new Error(`Verification failed, nothing committed: ${verdict.reason}`);
        }

        const { commit } = await commitFiles(cfg, changes, `learn: ingest ${params.title}`);

        // Refresh the pgvector index for every page whose content changed.
        await upsertVaultPage(
            { path: pagePath, title: params.title, summary: authored.summary, category },
            authored.markdown,
            params.embRef,
        );
        for (const hit of backlinked) {
            const content = backlinkContent.get(hit.path);
            if (!content) continue;
            await upsertVaultPage(
                { path: hit.path, title: hit.title, summary: hit.summary, category: hit.category },
                content,
                params.embRef,
            );
        }

        return {
            pagePath,
            commit,
            summary: authored.summary,
            links: authored.links,
            updatedExisting: !!existing,
        };
    });
}

function parseTitle(markdown: string, fallback: string): string {
    const fm = markdown.match(/^title:\s*(.+)$/m);
    if (fm) return fm[1].trim().replace(/^["']|["']$/g, "");
    const h1 = markdown.match(/^#\s+(.+)$/m);
    return h1 ? h1[1].trim() : fallback;
}

export interface WriteResult {
    pagePath: string;
    commit: string;
    created: boolean;
}

/**
 * Direct page write for deliberate agent edits (corrections, expansions).
 * Skips authoring and the verify gate, but still keeps index.md, log.md and
 * the pgvector index consistent, and commits atomically with a `learn:` prefix.
 */
export async function writeVaultPage(params: {
    path: string;
    markdown: string;
    summary?: string;
    embRef: ResolvedEmbedding;
}): Promise<WriteResult> {
    return withVaultLock(async () => {
        const cfg = requireVaultConfig();
        const rawPath = params.path.replace(/^\/+/, "").trim();

        // Uppercase, spaces and a missing .md are normalized rather than
        // rejected; only paths outside wiki/<category>/ are refused (index.md,
        // log.md, agents.md and raw/ are maintained by the pipeline).
        const match = rawPath.match(/^wiki\/(sources|concepts|entities|synthesis)\/(.+?)(?:\.md)?$/i);
        if (!match) {
            throw new Error(
                "vault_write only writes wiki pages: path must look like wiki/<sources|concepts|entities|synthesis>/<page-name>.md. index.md, log.md, agents.md and raw/ are maintained automatically.",
            );
        }
        const category = match[1].toLowerCase() as VaultCategory;
        const path = `wiki/${category}/${slugify(match[2])}.md`;

        const existing = await getFile(cfg, path);
        const title = parseTitle(params.markdown, path.split("/").pop()!.replace(/\.md$/, ""));
        const summary = (params.summary ?? "").replace(/\s+/g, " ").trim() || `${title} (updated ${today()})`;

        const [indexFile, logFile] = await Promise.all([
            getFile(cfg, "index.md"),
            getFile(cfg, "log.md"),
        ]);

        const changes: CommitFileChange[] = [
            { path, content: params.markdown },
            {
                path: "index.md",
                content: updateIndex(indexFile?.text ?? "# Index\n", category, path, summary),
            },
            {
                path: "log.md",
                content: appendLog(logFile?.text ?? "# Log\n", existing ? "update" : "write", title),
            },
        ];

        const { commit } = await commitFiles(
            cfg,
            changes,
            `learn: ${existing ? "update" : "write"} ${title}`,
        );

        await upsertVaultPage({ path, title, summary, category }, params.markdown, params.embRef);

        return { pagePath: path, commit, created: !existing };
    });
}
