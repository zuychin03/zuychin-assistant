import {
    commitFiles, getFile, requireVaultConfig,
    type CommitFileChange,
} from "@/lib/vault/github";
import { loadWikiPages, type VaultPage } from "@/lib/vault/lint";
import {
    deleteVaultPage, listVaultEmbeddings, listVaultPages,
    upsertVaultPage, type VaultPageRow,
} from "@/lib/vault/store";
import { addBacklink, appendLog, today, toWikilink } from "@/lib/vault/ingest";
import { withVaultLock } from "@/lib/vault/lock";
import { getEmbeddingRef } from "@/lib/ai/embeddings";
import { parseFrontmatter } from "@/lib/knowledge/markdown";
import { clusterNodes, pageRank, type Adjacency } from "@/lib/vault/graph-analysis";
import {
    listKnowledgeMetaByPath, readGraphSnapshot, replacePageLinks, writeGraphSnapshot,
    type KnowledgeDocumentDates,
} from "@/lib/vault/graph-store";
import { NODE_HEALTH } from "@/lib/vault/graph-types";
import type {
    GraphCluster, GraphEdge, GraphNode, HealthSummary, LinkSuggestion,
    NodeHealth, VaultGraph,
} from "@/lib/vault/graph-types";

export type { GraphCluster, GraphEdge, GraphNode, LinkSuggestion, NodeHealth, VaultGraph };

// Doc<->doc cosine below this is noise (see LINK_THRESHOLD rationale in ingest.ts).
const SUGGEST_THRESHOLD = 0.5;
const MAX_SUGGESTIONS = 15;
// Per-page candidates are reviewed one at a time, so a looser bar is useful there
// than for the graph-wide overlay.
const PAGE_SUGGEST_THRESHOLD = 0.35;
const MAX_PAGE_SUGGESTIONS = 8;
const STALE_DAYS = 180;

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTitle(markdown: string, fallback: string): string {
    const fm = markdown.match(/^title:\s*(.+)$/m);
    if (fm) return fm[1].trim().replace(/^["']|["']$/g, "");
    const h1 = markdown.match(/^#\s+(.+)$/m);
    return h1 ? h1[1].trim() : fallback;
}

function parseUpdated(markdown: string): string | null {
    const m = markdown.match(/^updated:\s*(\d{4}-\d{2}-\d{2})/m);
    return m ? m[1] : null;
}

function daysSince(value: string | null): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    return (Date.now() - parsed) / 86_400_000;
}

const TRUST_VALUES = new Set(["trusted", "reviewed", "untrusted"]);
const STATUS_VALUES = new Set(["active", "suggested", "superseded", "archived", "deleted"]);

/**
 * Lifecycle metadata for one page. knowledge_documents wins when present (it has
 * real timestamps); frontmatter is the fallback so a vault older than the
 * knowledge tables still renders with meaningful trust and status.
 */
function resolveMeta(page: VaultPage, row: KnowledgeDocumentDates | undefined) {
    const attributes = parseFrontmatter(page.text).attributes;
    const attribute = (key: string): string | undefined => {
        const value = attributes[key];
        return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };

    const trustRaw = row?.trust ?? attribute("trust") ?? "reviewed";
    const statusRaw = row?.status ?? attribute("status") ?? "active";
    return {
        trust: (TRUST_VALUES.has(trustRaw) ? trustRaw : "reviewed") as GraphNode["trust"],
        status: (STATUS_VALUES.has(statusRaw) ? statusRaw : "active") as GraphNode["status"],
        scope: row?.scope ?? attribute("scope") ?? "user",
        sensitivity: row?.sensitivity ?? attribute("sensitivity") ?? "private",
        kind: row?.kind ?? attribute("type") ?? "semantic",
        created: row?.createdAt ?? attribute("created") ?? null,
        malformed: !page.text.startsWith("---") || !attribute("title") || !attribute("category"),
    };
}

function emptyHealthSummary(): HealthSummary {
    return Object.fromEntries(NODE_HEALTH.map((key) => [key, 0])) as HealthSummary;
}

function buildClusters(nodes: GraphNode[]): GraphCluster[] {
    const byCluster = new Map<number, GraphNode[]>();
    for (const node of nodes) {
        if (node.cluster < 0) continue;
        const members = byCluster.get(node.cluster);
        if (members) members.push(node);
        else byCluster.set(node.cluster, [node]);
    }

    return [...byCluster.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, members]) => {
            const lead = members.reduce((best, node) => (node.centrality > best.centrality ? node : best), members[0]);
            const categoryMix: Record<string, number> = {};
            for (const member of members) {
                categoryMix[member.category] = (categoryMix[member.category] ?? 0) + 1;
            }
            return { id, size: members.length, label: lead.title, categoryMix, centroidPath: lead.id };
        });
}

function humanize(path: string): string {
    return path.replace(/\.md$/, "").split("/").pop()!.replace(/-/g, " ");
}

function edgeKey(a: string, b: string): string {
    return [a, b].sort().join("|");
}

/**
 * Remove every wikilink to `target` from `text`: whole "- label [[x]]" bullets
 * are dropped, inline links keep their readable text. Bumps `updated:`.
 */
function stripLink(text: string, target: string): string {
    const base = escapeRegExp(toWikilink(target));
    const link = `\\[\\[${base}(?:\\.md)?(?:\\|[^\\]]*)?\\]\\]`;
    let out = text.replace(new RegExp(`^[ \\t]*-[^\\[\\n]*${link}[ \\t]*\\r?\\n?`, "gm"), "");
    out = out.replace(new RegExp(link, "g"), (m) => {
        const label = /\|([^\]]*)\]\]$/.exec(m)?.[1]?.trim();
        return label || humanize(target);
    });
    if (out !== text) out = out.replace(/^updated: .*$/m, `updated: ${today()}`);
    return out;
}

async function reembed(
    path: string,
    content: string,
    rowByPath: Map<string, VaultPageRow>,
    category: string,
): Promise<void> {
    const row = rowByPath.get(path);
    try {
        await upsertVaultPage(
            {
                path,
                title: row?.title ?? humanize(path),
                summary: row?.summary ?? "",
                category: row?.category ?? category,
            },
            content,
            getEmbeddingRef(row?.embeddingModel),
        );
    } catch (err) {
        console.warn(`[Vault] Re-embed failed for ${path}:`, err);
    }
}

function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

/** Similar-but-unlinked page pairs, computed from stored vectors (no API calls). */
async function suggestLinks(
    rows: VaultPageRow[],
    nodeIds: Set<string>,
    linked: Set<string>,
): Promise<LinkSuggestion[]> {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.embeddingModel, (counts.get(r.embeddingModel) ?? 0) + 1);
    const model = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!model) return [];

    const vecs = (await listVaultEmbeddings(model)).filter((v) => nodeIds.has(v.path));
    const out: LinkSuggestion[] = [];
    for (let i = 0; i < vecs.length; i++) {
        for (let j = i + 1; j < vecs.length; j++) {
            if (linked.has(edgeKey(vecs[i].path, vecs[j].path))) continue;
            const sim = cosine(vecs[i].embedding, vecs[j].embedding);
            if (sim >= SUGGEST_THRESHOLD) {
                out.push({ source: vecs[i].path, target: vecs[j].path, similarity: sim });
            }
        }
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, MAX_SUGGESTIONS);
}

export async function buildVaultGraph(includeSuggestions: boolean): Promise<VaultGraph> {
    const cfg = requireVaultConfig();
    const [pages, rows, knowledgeMeta] = await Promise.all([
        loadWikiPages(cfg),
        listVaultPages(),
        listKnowledgeMetaByPath(),
    ]);
    const rowByPath = new Map(rows.map((r) => [r.path, r]));
    const pageByPath = new Map(pages.map((p) => [p.path, p]));

    const outboundPairs = new Set<string>(); // "a->b" directed
    const edges = new Map<string, GraphEdge>();
    const degree = new Map<string, number>();
    const adjacency: Adjacency = new Map();
    const dangling = new Map<string, number>();

    for (const p of pages) {
        adjacency.set(p.path, new Set());
        let missing = 0;
        for (const target of new Set(p.outbound)) {
            const t = `${target}.md`;
            if (t === p.path) continue;
            if (!pageByPath.has(t)) { missing++; continue; }
            outboundPairs.add(`${p.path}->${t}`);
        }
        dangling.set(p.path, missing);
    }
    for (const pair of outboundPairs) {
        const [a, b] = pair.split("->");
        const key = edgeKey(a, b);
        const existing = edges.get(key);
        if (existing) {
            existing.mutual = true;
        } else {
            edges.set(key, { source: a, target: b, mutual: false });
            degree.set(a, (degree.get(a) ?? 0) + 1);
            degree.set(b, (degree.get(b) ?? 0) + 1);
            adjacency.get(a)!.add(b);
            adjacency.get(b)!.add(a);
        }
    }

    const ids = pages.map((p) => p.path);
    const clusters = clusterNodes(ids, adjacency);
    const ranks = pageRank(ids, adjacency);
    const health = emptyHealthSummary();

    const nodes: GraphNode[] = pages.map((p) => {
        const row = rowByPath.get(p.path);
        const meta = resolveMeta(p, knowledgeMeta.get(p.path));
        const links = degree.get(p.path) ?? 0;
        const missing = dangling.get(p.path) ?? 0;
        const updated = parseUpdated(p.text) ?? row?.updatedAt?.slice(0, 10) ?? null;
        const age = daysSince(updated);

        const findings: NodeHealth[] = [];
        if (links === 0) findings.push("orphan");
        if (missing > 0) findings.push("dangling");
        if (age !== null && age > STALE_DAYS) findings.push("stale");
        if (meta.malformed) findings.push("malformed");
        if (meta.trust === "untrusted" || meta.status === "suggested") findings.push("unreviewed");
        for (const finding of findings) health[finding]++;

        return {
            id: p.path,
            title: parseTitle(p.text, row?.title ?? humanize(p.path)),
            category: p.category,
            summary: row?.summary ?? "",
            links,
            updated,
            created: meta.created,
            trust: meta.trust,
            status: meta.status,
            scope: meta.scope,
            sensitivity: meta.sensitivity,
            kind: meta.kind,
            cluster: clusters.get(p.path) ?? -1,
            centrality: ranks.get(p.path) ?? 0,
            words: p.text.split(/\s+/).length,
            health: findings,
            dangling: missing,
        };
    });

    const suggestions = includeSuggestions
        ? await suggestLinks(rows, new Set(ids), new Set(edges.keys()))
        : [];

    return {
        nodes,
        edges: [...edges.values()],
        suggestions,
        clusters: buildClusters(nodes),
        health,
        builtAt: new Date().toISOString(),
    };
}

/** Build, then persist the snapshot and the derived adjacency table. */
export async function rebuildVaultGraph(includeSuggestions = true): Promise<VaultGraph> {
    const startedAt = Date.now();
    const graph = await buildVaultGraph(includeSuggestions);
    await Promise.all([
        writeGraphSnapshot(graph, Date.now() - startedAt),
        replacePageLinks(graph.edges),
    ]);
    return graph;
}

/** Link candidates for one page, ranked by cosine against the stored vectors. */
export async function suggestLinksForPage(path: string): Promise<LinkSuggestion[]> {
    const rows = await listVaultPages();
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.embeddingModel, (counts.get(r.embeddingModel) ?? 0) + 1);
    const model = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!model) return [];

    const vectors = await listVaultEmbeddings(model);
    const own = vectors.find((v) => v.path === path);
    if (!own) return [];

    // Prefer the snapshot's edges: reading the whole repo from GitHub just to learn
    // what is already linked costs seconds on an interactive panel.
    const linked = new Set<string>();
    const snapshot = await readGraphSnapshot();
    if (snapshot) {
        for (const edge of snapshot.graph.edges) {
            if (edge.source === path) linked.add(edge.target);
            else if (edge.target === path) linked.add(edge.source);
        }
    } else {
        const pages = await loadWikiPages(requireVaultConfig());
        const page = pages.find((p) => p.path === path);
        for (const target of page?.outbound ?? []) linked.add(`${target}.md`);
        for (const other of pages) {
            if (other.outbound.some((target) => `${target}.md` === path)) linked.add(other.path);
        }
    }

    return vectors
        .filter((v) => v.path !== path && v.path.startsWith("wiki/") && !linked.has(v.path))
        .map((v) => ({ source: path, target: v.path, similarity: cosine(own.embedding, v.embedding) }))
        .filter((s) => s.similarity >= PAGE_SUGGEST_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_PAGE_SUGGESTIONS);
}

export interface GraphMutationResult {
    commit: string;
    changedPages: string[];
}

/**
 * Delete a wiki page and everything that points at it: wikilinks in other
 * pages, its index.md entry, and its pgvector row. One atomic commit.
 * The immutable raw/ capture is intentionally kept.
 */
export async function deleteGraphPage(path: string): Promise<GraphMutationResult> {
    return withVaultLock(async () => {
        const cfg = requireVaultConfig();
        const [pages, rows] = await Promise.all([loadWikiPages(cfg), listVaultPages()]);
        const page = pages.find((p) => p.path === path);
        if (!page) throw new Error(`Page not found: ${path}`);

        const rowByPath = new Map(rows.map((r) => [r.path, r]));
        const title = parseTitle(page.text, humanize(path));
        const link = toWikilink(path);

        const changes: CommitFileChange[] = [{ path, content: "", delete: true }];
        const cleaned: { path: string; content: string; category: string }[] = [];
        for (const p of pages) {
            if (p.path === path) continue;
            const next = stripLink(p.text, path);
            if (next !== p.text) {
                changes.push({ path: p.path, content: next });
                cleaned.push({ path: p.path, content: next, category: p.category });
            }
        }

        const [indexFile, logFile] = await Promise.all([
            getFile(cfg, "index.md"),
            getFile(cfg, "log.md"),
        ]);
        if (indexFile) {
            const nextIndex = indexFile.text
                .split("\n")
                .filter((l) => !l.includes(`[[${link}]]`))
                .join("\n");
            if (nextIndex !== indexFile.text) changes.push({ path: "index.md", content: nextIndex });
        }
        changes.push({ path: "log.md", content: appendLog(logFile?.text ?? "# Log\n", "delete", title) });

        const { commit } = await commitFiles(cfg, changes, `curator: delete ${title}`);

        await deleteVaultPage(path);
        for (const c of cleaned) await reembed(c.path, c.content, rowByPath, c.category);

        return { commit, changedPages: cleaned.map((c) => c.path) };
    });
}

/** Remove the connection between two pages in both directions. */
export async function deleteGraphLink(a: string, b: string): Promise<GraphMutationResult> {
    return withVaultLock(async () => {
        const cfg = requireVaultConfig();
        const [fileA, fileB, rows] = await Promise.all([
            getFile(cfg, a), getFile(cfg, b), listVaultPages(),
        ]);
        if (!fileA || !fileB) throw new Error("One of the linked pages no longer exists.");
        const rowByPath = new Map(rows.map((r) => [r.path, r]));

        const changes: CommitFileChange[] = [];
        const changed: { path: string; content: string }[] = [];
        const nextA = stripLink(fileA.text, b);
        if (nextA !== fileA.text) { changes.push({ path: a, content: nextA }); changed.push({ path: a, content: nextA }); }
        const nextB = stripLink(fileB.text, a);
        if (nextB !== fileB.text) { changes.push({ path: b, content: nextB }); changed.push({ path: b, content: nextB }); }
        if (changes.length === 0) throw new Error("No wikilink between these pages was found.");

        const logFile = await getFile(cfg, "log.md");
        changes.push({
            path: "log.md",
            content: appendLog(logFile?.text ?? "# Log\n", "unlink", `${humanize(a)} <-> ${humanize(b)}`),
        });

        const { commit } = await commitFiles(cfg, changes, `curator: unlink ${humanize(a)} <-> ${humanize(b)}`);
        for (const c of changed) await reembed(c.path, c.content, rowByPath, c.path.split("/")[1] ?? "concepts");

        return { commit, changedPages: changed.map((c) => c.path) };
    });
}

/** Link two pages with a labelled wikilink plus a back-reference. */
export async function createGraphLink(
    source: string,
    target: string,
    label: string,
): Promise<GraphMutationResult> {
    return withVaultLock(async () => {
        const cfg = requireVaultConfig();
        const [fileS, fileT, rows] = await Promise.all([
            getFile(cfg, source), getFile(cfg, target), listVaultPages(),
        ]);
        if (!fileS || !fileT) throw new Error("One of the pages no longer exists.");
        const rowByPath = new Map(rows.map((r) => [r.path, r]));
        const cleanLabel = label.trim().replace(/\s+/g, " ").slice(0, 60) || "related";

        const changes: CommitFileChange[] = [];
        const changed: { path: string; content: string }[] = [];
        const nextS = addBacklink(fileS.text, toWikilink(target), cleanLabel);
        if (nextS) { changes.push({ path: source, content: nextS }); changed.push({ path: source, content: nextS }); }
        const nextT = addBacklink(fileT.text, toWikilink(source), "related");
        if (nextT) { changes.push({ path: target, content: nextT }); changed.push({ path: target, content: nextT }); }
        if (changes.length === 0) throw new Error("These pages are already linked.");

        const logFile = await getFile(cfg, "log.md");
        changes.push({
            path: "log.md",
            content: appendLog(logFile?.text ?? "# Log\n", "link", `${humanize(source)} <-> ${humanize(target)}`),
        });

        const { commit } = await commitFiles(cfg, changes, `learn: link ${humanize(source)} <-> ${humanize(target)}`);
        for (const c of changed) await reembed(c.path, c.content, rowByPath, c.path.split("/")[1] ?? "concepts");

        return { commit, changedPages: changed.map((c) => c.path) };
    });
}
