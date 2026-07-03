import { ai, MODEL } from "@/lib/gemini";
import { Type, ThinkingLevel } from "@google/genai";
import {
    commitFiles, getFile, listDir, requireVaultConfig,
    type CommitFileChange, type VaultConfig,
} from "@/lib/vault/github";
import {
    deleteVaultPage, listVaultPages, upsertVaultPage, type VaultPageRow,
} from "@/lib/vault/store";
import {
    addBacklink, appendLog, toWikilink, updateIndex,
    VAULT_CATEGORIES, type VaultCategory,
} from "@/lib/vault/ingest";
import { withVaultLock } from "@/lib/vault/lock";
import { getEmbeddingRef, type ResolvedEmbedding } from "@/lib/ai/embeddings";

export type LintMode = "suggest" | "auto";

export interface LintResult {
    mode: LintMode;
    fixes: string[];      // applied (auto) or auto-fixable (suggest)
    warnings: string[];   // need judgement — never auto-fixed
    commit?: string;
    report: string;
}

export interface VaultPage {
    path: string;
    text: string;
    category: VaultCategory;
    outbound: string[]; // normalized wikilink targets (no .md), wiki/ only
}

export const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

export function extractLinks(text: string): string[] {
    const targets: string[] = [];
    for (const m of text.matchAll(WIKILINK_RE)) {
        const norm = m[1].trim().replace(/\.md$/, "");
        if (norm.startsWith("wiki/")) targets.push(norm);
    }
    return targets;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Unlink a dead wikilink but keep readable text ([[x|label]] → label, [[x]] → humanized slug). */
export function removeDeadLink(text: string, deadTarget: string): string {
    const fallback = deadTarget.replace(/\.md$/, "").split("/").pop()!.replace(/-/g, " ");
    const re = new RegExp(`\\[\\[${escapeRegExp(deadTarget)}(?:\\|([^\\]]*))?\\]\\]`, "g");
    return text.replace(re, (_m, label: string | undefined) => label?.trim() || fallback);
}

export async function loadWikiPages(cfg: VaultConfig): Promise<VaultPage[]> {
    const pages: VaultPage[] = [];
    for (const category of VAULT_CATEGORIES) {
        const entries = await listDir(cfg, `wiki/${category}`);
        const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
        const loaded = await Promise.all(files.map((e) => getFile(cfg, e.path)));
        for (const f of loaded) {
            if (f) pages.push({ path: f.path, text: f.text, category, outbound: extractLinks(f.text) });
        }
    }
    return pages;
}

/** LLM pass for the checks code can't do: contradictions and stale claims. Warnings only. */
async function reviewContent(pages: VaultPage[]): Promise<string[]> {
    if (pages.length < 2) return [];

    let budget = 45000;
    const blocks: string[] = [];
    for (const p of pages) {
        const excerpt = p.text.slice(0, 4000);
        if (budget - excerpt.length < 0) break;
        budget -= excerpt.length;
        blocks.push(`--- ${p.path} ---\n${excerpt}`);
    }

    const prompt = `You are the curator of a personal knowledge vault. Review these wiki pages for CONTENT problems only:
1. Contradictions — two pages making incompatible claims about the same thing.
2. Clearly stale claims — statements that were time-sensitive and are likely outdated.
3. Near-duplicate pages that should be merged.

Ignore style, formatting, links, and structure. If there are no real findings, return an empty list — do not invent problems.

${blocks.join("\n\n")}

Return JSON {findings: string[]} — each finding one sentence naming the page path(s) involved.`;

    try {
        const resp = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        findings: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ["findings"],
                },
            },
        });
        const parsed = JSON.parse(resp.text ?? "{}") as { findings?: string[] };
        return (parsed.findings ?? []).filter((f) => typeof f === "string" && f.trim());
    } catch (error) {
        console.error("[Vault] Lint content review failed:", error);
        return ["Content review (contradictions/staleness) was skipped — the reviewer call failed."];
    }
}

/** Independent gate before a curator commit: edits must be link/catalogue hygiene only. */
async function verifyFixes(params: {
    fixes: string[];
    changed: { path: string; before: string; after: string }[];
}): Promise<{ pass: boolean; reason: string }> {
    const diffs = params.changed
        .slice(0, 8)
        .map((c) => `--- ${c.path} (before, ${c.before.length} chars) ---\n${c.before.slice(0, 2500)}\n--- ${c.path} (after, ${c.after.length} chars) ---\n${c.after.slice(0, 2500)}`)
        .join("\n\n");

    const prompt = `You verify an automated maintenance commit to a knowledge vault. The ONLY allowed changes are link hygiene and cataloguing: adding back-reference links, unlinking dead wikilinks (keeping the text), adding/removing index.md catalogue lines, appending a log line, and bumping "updated:" dates.

Fail if any change removes or rewrites actual knowledge content, or does something other than the fixes listed.

Fixes claimed:
${params.fixes.map((f) => `- ${f}`).join("\n")}

Files before/after:
${diffs}

Return JSON {pass: boolean, reason: string} — one short sentence.`;

    try {
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
    } catch (error) {
        console.error("[Vault] Lint verifier failed:", error);
        return { pass: false, reason: "Verifier call failed — commit withheld." };
    }
}

function buildReport(result: Omit<LintResult, "report">): string {
    const lines: string[] = [];
    const verb = result.mode === "auto" ? "fixed" : "auto-fixable";
    lines.push(
        `Vault lint (${result.mode}): ${result.fixes.length} ${verb}, ${result.warnings.length} warning(s)` +
        (result.commit ? ` — committed ${result.commit.slice(0, 7)}` : ""),
    );
    if (result.fixes.length) {
        lines.push(`\n${result.mode === "auto" ? "Fixed" : "Would fix"}:`);
        for (const f of result.fixes) lines.push(`- ${f}`);
    }
    if (result.warnings.length) {
        lines.push("\nNeeds judgement:");
        for (const w of result.warnings) lines.push(`- ${w}`);
    }
    if (!result.fixes.length && !result.warnings.length) lines.push("The vault is healthy — nothing to do.");
    return lines.join("\n");
}

/**
 * LINT workflow from agents.md: orphans, dead links, missing back-references,
 * catalogue drift, semantic-index drift, plus an LLM content review.
 * suggest = report only. auto = apply low-risk fixes, verify, commit `curator:`.
 */
export async function lintVault(params: {
    mode: LintMode;
    embRef?: ResolvedEmbedding;
}): Promise<LintResult> {
    return withVaultLock(async () => {
        const cfg = requireVaultConfig();
        const mode = params.mode;
        const fixes: string[] = [];
        const warnings: string[] = [];

        const [pages, indexFile, logFile, rows] = await Promise.all([
            loadWikiPages(cfg),
            getFile(cfg, "index.md"),
            getFile(cfg, "log.md"),
            listVaultPages(),
        ]);
        const pageByPath = new Map(pages.map((p) => [p.path, p]));
        const rowByPath = new Map<string, VaultPageRow>(rows.map((r) => [r.path, r]));

        // Working copies for auto-fixes; only changed ones end up in the commit.
        const content = new Map(pages.map((p) => [p.path, p.text]));
        const changedPages = new Set<string>();
        const edit = (path: string, next: string) => {
            if (next !== content.get(path)) {
                content.set(path, next);
                changedPages.add(path);
            }
        };

        // 1. Frontmatter sanity (warn only — rewriting content is not low-risk).
        for (const p of pages) {
            if (!p.text.startsWith("---") || !/^title:/m.test(p.text) || !/^category:/m.test(p.text)) {
                warnings.push(`${p.path}: missing or malformed frontmatter (needs title/category/created/updated).`);
            }
        }

        // 2. Dead links → unlink, keep the text.
        for (const p of pages) {
            const seen = new Set<string>();
            for (const m of p.text.matchAll(WIKILINK_RE)) {
                const raw = m[1].trim();
                const norm = raw.replace(/\.md$/, "");
                if (!norm.startsWith("wiki/") || pageByPath.has(`${norm}.md`) || seen.has(raw)) continue;
                seen.add(raw);
                fixes.push(`${p.path}: dead link [[${raw}]] — unlink, keep the text.`);
                if (mode === "auto") edit(p.path, removeDeadLink(content.get(p.path)!, raw));
            }
        }

        // 3. Missing back-references → add a labelled line under ## Related.
        const backlinked = new Set<string>();
        for (const a of pages) {
            for (const target of a.outbound) {
                const b = pageByPath.get(`${target}.md`);
                if (!b || b.path === a.path) continue;
                if (b.outbound.includes(toWikilink(a.path))) continue;
                const key = `${b.path}<-${a.path}`;
                if (backlinked.has(key)) continue;
                backlinked.add(key);
                fixes.push(`${b.path}: add back-reference to [[${toWikilink(a.path)}]].`);
                if (mode === "auto") {
                    const updated = addBacklink(content.get(b.path)!, toWikilink(a.path), "related");
                    if (updated) edit(b.path, updated);
                }
            }
        }

        // 4. Orphans (no inbound links) — judgement call, warn only.
        if (pages.length > 1) {
            const inbound = new Set(pages.flatMap((p) => p.outbound));
            for (const p of pages) {
                if (!inbound.has(toWikilink(p.path))) {
                    warnings.push(`${p.path}: orphan — no other page links to it. Link it from a related page or merge it.`);
                }
            }
        }

        // 5. Catalogue drift: index.md vs actual pages.
        let indexText = indexFile?.text ?? "# Index\n";
        const listed = new Set(extractLinks(indexText).map((l) => `${l}.md`));
        for (const p of pages) {
            if (listed.has(p.path)) continue;
            const summary = rowByPath.get(p.path)?.summary || p.path.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " ");
            fixes.push(`index.md: missing entry for ${p.path} — add it.`);
            if (mode === "auto") indexText = updateIndex(indexText, p.category, p.path, summary);
        }
        for (const l of listed) {
            if (pageByPath.has(l)) continue;
            fixes.push(`index.md: entry points to missing page ${l} — remove the line.`);
            if (mode === "auto") {
                indexText = indexText
                    .split("\n")
                    .filter((line) => !line.includes(`[[${toWikilink(l)}]]`))
                    .join("\n");
            }
        }
        const indexChanged = mode === "auto" && indexText !== (indexFile?.text ?? "# Index\n");

        // 6. Semantic-index drift: pgvector rows vs actual pages.
        const missingRows = pages.filter((p) => !rowByPath.has(p.path));
        const staleRows = rows.filter((r) => !pageByPath.has(r.path));
        for (const p of missingRows) fixes.push(`semantic index: ${p.path} is not embedded — vault_search cannot find it. Re-index it.`);
        for (const r of staleRows) fixes.push(`semantic index: stale row for deleted page ${r.path} — remove it.`);
        const models = new Set(rows.map((r) => r.embeddingModel));
        if (models.size > 1) {
            warnings.push(`semantic index: pages are split across ${models.size} embedding models (${[...models].join(", ")}) — vault_search only sees the active model's partition. Re-ingest the minority pages with one model.`);
        }

        // 7. Content review (contradictions / staleness / duplicates) — warnings only.
        warnings.push(...await reviewContent(pages));

        if (mode === "suggest") {
            const result = { mode, fixes, warnings } as Omit<LintResult, "report">;
            return { ...result, report: buildReport(result) };
        }

        // ---- auto mode: verify, commit, reconcile the semantic index ----
        let commit: string | undefined;
        const repoFixCount = fixes.length - missingRows.length - staleRows.length;

        if (changedPages.size > 0 || indexChanged) {
            const changed = [...changedPages].map((path) => ({
                path,
                before: pageByPath.get(path)!.text,
                after: content.get(path)!,
            }));
            if (indexChanged) {
                changed.push({ path: "index.md", before: indexFile?.text ?? "", after: indexText });
            }

            const verdict = await verifyFixes({ fixes, changed });
            if (!verdict.pass) {
                warnings.push(`Auto-fix verification failed, nothing committed: ${verdict.reason}`);
                const result = { mode, fixes: [], warnings } as Omit<LintResult, "report">;
                return { ...result, report: buildReport(result) };
            }

            const changes: CommitFileChange[] = [...changedPages].map((path) => ({
                path,
                content: content.get(path)!,
            }));
            if (indexChanged) changes.push({ path: "index.md", content: indexText });
            changes.push({
                path: "log.md",
                content: appendLog(logFile?.text ?? "# Log\n", "lint", `fixed ${repoFixCount}, ${warnings.length} warning(s)`),
            });

            ({ commit } = await commitFiles(cfg, changes, `curator: lint — fixed ${repoFixCount} issue(s)`));

            // Re-embed changed pages in their EXISTING model partition.
            for (const path of changedPages) {
                const row = rowByPath.get(path);
                const page = pageByPath.get(path)!;
                await upsertVaultPage(
                    {
                        path,
                        title: row?.title ?? path.split("/").pop()!.replace(/\.md$/, ""),
                        summary: row?.summary ?? "",
                        category: page.category,
                    },
                    content.get(path)!,
                    row ? getEmbeddingRef(row.embeddingModel) : (params.embRef ?? getEmbeddingRef()),
                );
            }
        }

        // pgvector reconciliation needs no commit.
        for (const p of missingRows) {
            await upsertVaultPage(
                { path: p.path, title: p.path.split("/").pop()!.replace(/\.md$/, ""), summary: "", category: p.category },
                content.get(p.path)!,
                params.embRef ?? getEmbeddingRef(),
            );
        }
        for (const r of staleRows) await deleteVaultPage(r.path);

        const result = { mode, fixes, warnings, commit } as Omit<LintResult, "report">;
        return { ...result, report: buildReport(result) };
    });
}
