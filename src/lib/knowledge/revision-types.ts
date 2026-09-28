export interface KnowledgeRevision {
    commitSha: string;
    path: string;
    committedAt: string;
    message: string;
    author: string;
}
export interface KnowledgeEvidence {
    version: 1;
    documentId: string;
    path: string;
    commitSha: string;
    contentHash: string;
    quote: string;
    quoteHash: string;
    // Offsets are UTF-16 code units into LF-normalised full Markdown.
    startOffset: number;
    endOffset: number;
}
export interface RevisionDiff {
    kind: "equal" | "removed" | "added";
    text: string;
}
export interface KnowledgeRevisionPreview {
    documentId: string;
    path: string;
    sourcePath: string;
    sourceSha: string;
    headSha: string;
    currentHash: string | null;
    previewHash: string;
    currentMarkdown: string;
    historicalMarkdown: string;
    restoredMarkdown: string;
    diff: RevisionDiff[];
}
