export interface Message {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    imageUrl?: string;
    channel: MessageChannel;
    createdAt: string;
    metadata?: MessageMetadata;
}

export type ArtifactKind = "document" | "code" | "archive";

export interface ArtifactDescriptor {
    id: string;
    name: string;
    mime: string;
    kind: ArtifactKind;
    size: number;
}

/** Quoted excerpt of an earlier message the user is replying to. */
export interface ReplyRef {
    role: "user" | "assistant";
    content: string;
}

export interface MessageMetadata {
    artifacts?: ArtifactDescriptor[];
    replyTo?: ReplyRef;
    [key: string]: unknown;
}

export type MessageChannel = "web" | "discord" | "telegram" | "slack";

export interface ChatRequest {
    message: string;
    imageBase64?: string;
    channel: MessageChannel;
    conversationId?: string;
    file?: FileAttachment;
}

export interface FileAttachment {
    name: string;
    mimeType: string;
    base64: string;
    size: number;
}

export const SUPPORTED_MIME_TYPES: Record<string, string[]> = {
    images: ["image/jpeg", "image/png", "image/webp", "image/heic"],
    audio: ["audio/mp3", "audio/mpeg", "audio/wav", "audio/flac", "audio/ogg", "audio/m4a", "audio/x-aac", "audio/webm", "audio/mp4"],
    video: ["video/mp4", "video/quicktime", "video/webm"],
    documents: ["application/pdf"],
    text: [
        "text/plain", "text/markdown", "text/x-markdown", "text/csv",
        "text/tab-separated-values", "text/html", "text/css", "text/javascript",
        "text/yaml", "text/x-yaml", "text/xml",
        "application/json", "application/x-ndjson", "application/xml",
        "application/yaml", "application/x-yaml", "application/toml",
    ],
};

export const ALL_SUPPORTED_MIME_TYPES = Object.values(SUPPORTED_MIME_TYPES).flat();

export const MAX_FILE_SIZE_MB = 20;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export const TEXT_LIKE_EXTENSIONS = [
    "txt", "text", "md", "markdown", "mdx", "rst",
    "csv", "tsv", "json", "jsonl", "ndjson",
    "yaml", "yml", "toml", "xml", "html", "htm",
    "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "cc",
    "cs", "php", "swift", "sh", "bash", "zsh", "sql",
    "ini", "cfg", "conf", "env", "properties", "log", "tex",
];

export const UPLOAD_ACCEPT = [
    "image/*", "audio/*", "video/*", ".pdf",
    ...TEXT_LIKE_EXTENSIONS.map((e) => `.${e}`),
].join(",");

function getFileExtension(name: string): string {
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function isTextLikeAttachment(mimeType: string, name: string): boolean {
    if (mimeType && (mimeType.startsWith("text/") || SUPPORTED_MIME_TYPES.text.includes(mimeType))) {
        return true;
    }
    return TEXT_LIKE_EXTENSIONS.includes(getFileExtension(name));
}

export function isSupportedAttachment(mimeType: string, name: string): boolean {
    if (mimeType && ALL_SUPPORTED_MIME_TYPES.includes(mimeType)) return true;
    return isTextLikeAttachment(mimeType, name);
}

export interface ChatResponse {
    reply: string;
    messageId: string;
    artifacts?: ArtifactDescriptor[];
}

export interface BotStatus {
    model: string;
    isActive: boolean;
    lastActivity: string;
    totalMessages: number;
}

export interface KnowledgeItem {
    id: string;
    content: string;
    embedding?: number[];
    metadata?: Record<string, string>;
    similarity?: number;
    createdAt: string;
}

// Candidate work/study facts need this many distinct-conversation sightings
// before they surface as Known Facts. Client-safe home so the admin panel can
// show it without pulling in the server-side memory store.
export const PROMOTE_EVIDENCE_COUNT = 3;
