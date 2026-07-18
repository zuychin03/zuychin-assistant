export const KNOWLEDGE_KINDS = ["document", "semantic", "episodic", "procedural", "working"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_SCOPES = ["user", "project", "repository", "session"] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

export const KNOWLEDGE_STATUSES = ["active", "suggested", "superseded", "archived", "deleted"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_TRUST = ["trusted", "reviewed", "untrusted"] as const;
export type KnowledgeTrust = (typeof KNOWLEDGE_TRUST)[number];

export type KnowledgeSensitivity = "normal" | "private" | "secret";

export interface KnowledgeProvenance {
    source: string;
    sourceUrl?: string;
    sourcePath?: string;
    capturedAt: string;
    contentHash?: string;
}

export interface KnowledgeDocumentMeta {
    id: string;
    path: string;
    title: string;
    summary: string;
    category: string;
    kind: KnowledgeKind;
    scope: KnowledgeScope;
    status: KnowledgeStatus;
    trust: KnowledgeTrust;
    sensitivity: KnowledgeSensitivity;
    projectId?: string;
    supersedesId?: string;
    validFrom?: string;
    validTo?: string;
    createdAt: string;
    updatedAt: string;
    contentHash: string;
    provenance: KnowledgeProvenance[];
}

export interface KnowledgeChunk {
    id: string;
    documentId: string;
    path: string;
    heading: string;
    headingPath: string[];
    ordinal: number;
    content: string;
    contentHash: string;
    tokenCount: number;
}

export interface KnowledgeScoreBreakdown {
    semantic: number;
    lexical: number;
    graph: number;
    authority: number;
    freshness: number;
    importance: number;
    final: number;
}

export interface KnowledgeRecallHit {
    documentId: string;
    chunkId: string;
    path: string;
    title: string;
    heading: string;
    excerpt: string;
    category: string;
    score: KnowledgeScoreBreakdown;
    provenance: KnowledgeProvenance[];
}

export type KnowledgeEventAction =
    | "created"
    | "updated"
    | "corrected"
    | "promoted"
    | "merged"
    | "archived"
    | "restored"
    | "deleted"
    | "indexed"
    | "imported";

export interface KnowledgeEvent {
    documentId: string;
    action: KnowledgeEventAction;
    actor: "user" | "assistant" | "system";
    detail?: Record<string, unknown>;
    occurredAt?: string;
}
