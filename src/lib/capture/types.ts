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
}
export interface CaptureReview { title: string; text: string; destination: string }
export interface CapturePreview {
    id: string; review: CaptureReview; path: string; markdown: string; originalPath: string | null;
    headSha: string; previewHash: string; existing: boolean;
}
