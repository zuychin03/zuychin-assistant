import { hashContent, parseFrontmatter, serializeFrontmatter } from "@/lib/knowledge/markdown";
import type { KnowledgeEvidence, KnowledgeRevision, KnowledgeRevisionPreview, RevisionDiff } from "@/lib/knowledge/revision-types";

export interface RevisionDocument {
    id: string; path: string; title: string; summary: string; category: string;
    scope: string; trust: string; status: string; sensitivity: string; project_id?: string | null;
}
export interface RevisionDependencies {
    getDocument(id: string): Promise<RevisionDocument | null>;
    getHead(): Promise<string>;
    getFile(path: string, sha: string): Promise<{ text: string; sha: string } | null>;
    isAncestor(sha: string, head: string): Promise<boolean>;
    list(path: string, head: string, page: number): Promise<{ revisions: KnowledgeRevision[]; hasMore: boolean }>;
    commit(changes: { path: string; content: string }[], expectedHead: string): Promise<{ commit: string }>;
    index(document: RevisionDocument, markdown: string): Promise<void>;
    recordEvent(event: Record<string, unknown>): Promise<void>;
}
export class KnowledgeRevisionError extends Error {
    constructor(message: string, readonly status = 400) { super(message); this.name = "KnowledgeRevisionError"; }
}
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const normalise = (text: string) => text.replace(/\r\n/g, "\n");
function validPath(path: string): boolean {
    return path.length <= 1024 && path.endsWith(".md") && !/[\\\x00-\x1f]/.test(path)
        && path.split("/").every((part) => !!part && part !== "." && part !== ".." && !part.startsWith(".git"));
}
function diffLines(before: string, after: string): RevisionDiff[] {
    const left = before.split("\n"), right = after.split("\n");
    let prefix = 0, suffix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
    while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
    const result: RevisionDiff[] = [];
    const add = (kind: RevisionDiff["kind"], lines: string[]) => { if (lines.length) result.push({ kind, text: lines.join("\n") }); };
    add("equal", left.slice(0, prefix));
    add("removed", left.slice(prefix, left.length - suffix));
    add("added", right.slice(prefix, right.length - suffix));
    add("equal", left.slice(left.length - suffix));
    return result;
}

export function createRevisionService(deps: RevisionDependencies) {
    const getDocument = async (id: string) => {
        if (!id || id.length > 200) throw new KnowledgeRevisionError("A valid document is required.");
        const document = await deps.getDocument(id);
        if (!document) throw new KnowledgeRevisionError("Knowledge document not found.", 404);
        if (!validPath(document.path)) throw new KnowledgeRevisionError("This document path is unavailable for revisions.");
        return document;
    };
    const readSnapshot = async (document: RevisionDocument, commitSha: string, head: string, sourcePath = document.path) => {
        if (!SHA.test(commitSha) || !validPath(sourcePath)) throw new KnowledgeRevisionError("A valid immutable revision and path are required.");
        if (!await deps.isAncestor(commitSha, head)) throw new KnowledgeRevisionError("This revision is not in the configured vault history.", 404);
        const file = await deps.getFile(sourcePath, commitSha);
        if (!file) throw new KnowledgeRevisionError("The document is absent at this revision.", 404);
        if (file.text.length > 1_000_000) throw new KnowledgeRevisionError("This revision is too large to preview.");
        const markdown = normalise(file.text);
        const id = parseFrontmatter(markdown).attributes.zuychin_id;
        if ((id && id !== document.id) || (sourcePath !== document.path && id !== document.id)) throw new KnowledgeRevisionError("The revision belongs to a different document.", 409);
        return { markdown, path: sourcePath, commitSha, contentHash: hashContent(markdown) };
    };
    const preview = async (input: { documentId: string; sourceSha: string; sourcePath?: string }): Promise<KnowledgeRevisionPreview> => {
        const document = await getDocument(input.documentId);
        const headSha = await deps.getHead();
        const snapshot = await readSnapshot(document, input.sourceSha, headSha, input.sourcePath);
        const currentFile = await deps.getFile(document.path, headSha);
        if (currentFile && currentFile.text.length > 1_000_000) throw new KnowledgeRevisionError("The current document is too large to preview.");
        const currentMarkdown = normalise(currentFile?.text ?? "");
        const restored = parseFrontmatter(currentMarkdown);
        if (restored.attributes.zuychin_id && restored.attributes.zuychin_id !== document.id) throw new KnowledgeRevisionError("The current path belongs to a different document.", 409);
        Object.assign(restored.attributes, {
            scope: document.scope, trust: document.trust, status: document.status,
            sensitivity: document.sensitivity, ...(document.project_id ? { project_id: document.project_id } : {}),
        });
        if (!document.project_id) delete restored.attributes.project_id;
        restored.attributes.zuychin_id = document.id;
        restored.attributes.updated = new Date().toISOString().slice(0, 10);
        restored.body = parseFrontmatter(snapshot.markdown).body;
        const restoredMarkdown = serializeFrontmatter(restored);
        return { documentId: document.id, path: document.path, sourcePath: snapshot.path, sourceSha: snapshot.commitSha,
            headSha, currentHash: currentFile ? hashContent(currentMarkdown) : null, previewHash: hashContent(restoredMarkdown),
            currentMarkdown, historicalMarkdown: snapshot.markdown, restoredMarkdown, diff: diffLines(currentMarkdown, restoredMarkdown) };
    };
    return {
        async list(input: { documentId: string; page?: number; headSha?: string }) {
            const document = await getDocument(input.documentId);
            const page = input.page ?? 1;
            if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new KnowledgeRevisionError("Invalid revision page.");
            const currentHead = await deps.getHead();
            const headSha = input.headSha ?? currentHead;
            if (!SHA.test(headSha) || (headSha !== currentHead && !await deps.isAncestor(headSha, currentHead))) throw new KnowledgeRevisionError("Invalid history snapshot.");
            return { documentId: document.id, path: document.path, headSha, page, ...await deps.list(document.path, headSha, page) };
        },
        preview,
        async restore(input: Pick<KnowledgeRevisionPreview, "documentId" | "sourceSha" | "sourcePath" | "headSha" | "currentHash" | "previewHash">) {
            if (!SHA.test(input.headSha) || !HASH.test(input.previewHash) || (input.currentHash !== null && !HASH.test(input.currentHash))) throw new KnowledgeRevisionError("A valid restore preview is required.");
            const current = await preview(input);
            if (current.headSha !== input.headSha || current.currentHash !== input.currentHash) throw new KnowledgeRevisionError("The document or vault changed. Preview the restore again.", 409);
            if (current.previewHash !== input.previewHash) throw new KnowledgeRevisionError("The restore preview changed. Preview the restore again.", 409);
            const document = await getDocument(input.documentId);
            if (document.path !== current.path) throw new KnowledgeRevisionError("The document path changed. Preview the restore again.", 409);
            const { commit } = await deps.commit([{ path: current.path, content: current.restoredMarkdown }], current.headSha);
            let indexed = true, eventRecorded = true;
            try { await deps.index(document, current.restoredMarkdown); } catch { indexed = false; }
            try { await deps.recordEvent({ documentId: document.id, path: current.path, commit, sourceSha: current.sourceSha, sourcePath: current.sourcePath, contentHash: current.previewHash }); } catch { eventRecorded = false; }
            return { commit, indexed, eventRecorded, warning: !indexed ? "The revision was saved, but indexing failed. Reconcile the knowledge library before relying on recall."
                : !eventRecorded ? "The revision was saved, but the lifecycle event could not be recorded. Git history remains available." : null };
        },
        async snapshot(input: { documentId: string; commitSha: string; path?: string }) {
            const document = await getDocument(input.documentId);
            return { documentId: document.id, ...await readSnapshot(document, input.commitSha, await deps.getHead(), input.path) };
        },
        async evidence(input: { documentId: string; commitSha: string; path?: string; quote: string; startOffset?: number }): Promise<KnowledgeEvidence> {
            if (typeof input.quote !== "string" || !input.quote.trim() || input.quote.length > 20_000) throw new KnowledgeRevisionError("A quoted passage of at most 20,000 characters is required.");
            const document = await getDocument(input.documentId);
            const snapshot = await readSnapshot(document, input.commitSha, await deps.getHead(), input.path);
            const quote = normalise(input.quote);
            const first = snapshot.markdown.indexOf(quote);
            if (input.startOffset === undefined && first >= 0 && snapshot.markdown.indexOf(quote, first + 1) >= 0) throw new KnowledgeRevisionError("The passage is ambiguous. Supply its exact UTF-16 startOffset.");
            const startOffset = input.startOffset ?? first;
            if (!Number.isSafeInteger(startOffset) || startOffset < 0 || snapshot.markdown.slice(startOffset, startOffset + quote.length) !== quote) throw new KnowledgeRevisionError("The quoted passage does not match this revision.");
            return { version: 1, documentId: document.id, path: snapshot.path, commitSha: snapshot.commitSha, contentHash: snapshot.contentHash,
                quote, quoteHash: hashContent(quote), startOffset, endOffset: startOffset + quote.length };
        },
    };
}
