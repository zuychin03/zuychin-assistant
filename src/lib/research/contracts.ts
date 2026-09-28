import { z } from "zod";
import type { KnowledgeEvidence } from "../knowledge/revision-types";

export const researchKinds = ["annotation", "claim", "interpretation", "method", "finding", "limitation"] as const;
export type ResearchKind = typeof researchKinds[number];
export interface ResearchQuestion { id: string; projectId: string; title: string; question: string; status: "active" | "archived"; version: number; updatedAt: string }
export interface ResearchSource { id: string; questionId: string; documentId: string; path: string; commitSha: string; contentHash: string; title: string; version: number; removedAt: string | null }
export interface ResearchEntry { id: string; questionId: string; sourceId: string | null; kind: ResearchKind; text: string; evidence: KnowledgeEvidence | null; version: number; updatedAt: string }
export interface ResearchDocument { id: string; path: string; title: string; project_id: string | null; user_profile_id?: string | null; scope: string; status: string }
export interface ResearchWorkspace { question: ResearchQuestion; sources: ResearchSource[]; entries: ResearchEntry[]; documents: ResearchDocument[] }
export class ResearchError extends Error {
    constructor(message: string, readonly status = 400, readonly current?: unknown) { super(message); this.name = "ResearchError"; }
}
const id = z.string().uuid();
const shortText = z.string().trim().min(1).max(160);
export const questionSchema = z.object({ id, projectId: id, title: shortText, question: z.string().trim().min(1).max(8000), version: z.number().int().positive().optional(), status: z.enum(["active", "archived"]).default("active") }).strict();
export const sourceSchema = z.object({ id, questionId: id, documentId: z.string().min(1).max(200), commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), title: shortText.optional() }).strict();
export const editSourceSchema = z.object({ id, questionId: id, version: z.number().int().positive(), title: shortText.optional(), remove: z.boolean().optional() }).strict().refine((input) => input.title !== undefined || input.remove === true);
export const deleteEntrySchema = z.object({ id, questionId: id, version: z.number().int().positive() }).strict();
const entrySchema = z.object({ id, questionId: id, sourceId: id.nullable().default(null), kind: z.enum(researchKinds),
    text: z.string().trim().min(1).max(20_000), quote: z.string().min(1).max(20_000).optional(), startOffset: z.number().int().nonnegative().optional(),
    version: z.number().int().positive().optional(),
}).strict();
export function parseResearchEntry(value: unknown) {
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) throw new ResearchError("Provide valid note text, IDs and a non-negative passage offset.");
    const input = parsed.data;
    if (input.kind !== "interpretation" && (!input.sourceId || !input.quote || input.startOffset === undefined)) {
        throw new ResearchError("A selected source passage and its exact offset are required for evidence-backed notes.");
    }
    if (input.kind === "interpretation" && (input.quote !== undefined || input.startOffset !== undefined)) {
        throw new ResearchError("Interpretations are authored notes. Use a source-backed note type for a quoted passage.");
    }
    return input;
}
export function assertEvidenceMatchesSource(evidence: KnowledgeEvidence, source: ResearchSource) {
    if (evidence.version !== 1 || evidence.documentId !== source.documentId || evidence.path !== source.path
        || evidence.commitSha !== source.commitSha || evidence.contentHash !== source.contentHash
        || evidence.endOffset - evidence.startOffset !== evidence.quote.length) {
        throw new ResearchError("The passage does not match the selected immutable source. Reload its snapshot.", 409);
    }
}
export function documentInResearchScope(document: ResearchDocument, userId: string, projectId: string): boolean {
    return document.status === "active" && (!document.user_profile_id || document.user_profile_id === userId)
        && (document.project_id === projectId || (!document.project_id && ["user", "repository"].includes(document.scope)));
}
export function researchComparison(workspace: ResearchWorkspace) {
    return workspace.sources.map((source) => ({ source,
        methods: workspace.entries.filter((entry) => entry.sourceId === source.id && entry.kind === "method"),
        findings: workspace.entries.filter((entry) => entry.sourceId === source.id && entry.kind === "finding"),
        limitations: workspace.entries.filter((entry) => entry.sourceId === source.id && entry.kind === "limitation"),
    }));
}
