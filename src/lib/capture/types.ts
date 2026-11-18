export interface CaptureSource {
    kind: "text" | "link" | "pdf" | "offline_note";
    title: string;
    text: string;
    url?: string;
    pdf?: { name: string; base64: string };
    source?: { documentId: string; path: string; commitSha: string; contentHash: string };
}
export interface CaptureItem {
    id: string;
    profileId: string;
    source: CaptureSource;
    sourceHash: string;
    createdAt: string;
    receipt: { path: string; commit: string; indexed: boolean } | null;
    extract?: CaptureExtract | null;
    extractStatus?: CaptureExtractStatus | null;
}
export interface CaptureReview { title: string; text: string; destination: string; sourceText?: string }
export type OcrTier = "free" | "paid";
export type CaptureExtractStatus = "ok" | "empty" | "scanned" | "locked" | "blocked" | "failed" | "running";
export type CaptureExtractMethod = "html" | "plain" | "pdf-text" | "tavily" | "ocr-free" | "ocr-paid";
export interface CaptureExtract {
    version: 1;
    status: CaptureExtractStatus;
    method: CaptureExtractMethod;
    text: string;
    truncated: boolean;
    words: number;
    fetchedAt: string;
    finalUrl?: string; contentType?: string; pages?: number;
    title?: string; author?: string; site?: string; published?: string;
    note?: string;
    startedAt?: string;
}
export interface CapturePreview {
    id: string; review: CaptureReview; path: string; markdown: string; originalPath: string | null;
    headSha: string; previewHash: string; existing: boolean;
}
