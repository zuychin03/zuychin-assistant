

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

// Lightweight descriptor stored on the assistant message (metadata) and returned
// to the client. The actual bytes live in the `artifacts` table, fetched on
// demand from GET /api/artifacts/[id].
export interface ArtifactDescriptor {
    id: string;
    name: string;   // filename, e.g. "outage-report.pdf"
    mime: string;
    kind: ArtifactKind;
    size: number;
}

export interface MessageMetadata {
    artifacts?: ArtifactDescriptor[];
    [key: string]: unknown;
}

export type MessageChannel = "web" | "discord" | "telegram";

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
    audio: ["audio/mp3", "audio/mpeg", "audio/wav", "audio/flac", "audio/ogg", "audio/m4a", "audio/x-aac"],
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

// Browsers report inconsistent (often empty) MIME types for machine-readable
// files like .md / .yaml / .csv, so we also recognise them by extension.
export const TEXT_LIKE_EXTENSIONS = [
    "txt", "text", "md", "markdown", "mdx", "rst",
    "csv", "tsv", "json", "jsonl", "ndjson",
    "yaml", "yml", "toml", "xml", "html", "htm",
    "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "cc",
    "cs", "php", "swift", "sh", "bash", "zsh", "sql",
    "ini", "cfg", "conf", "env", "properties", "log", "tex",
];

/** The `accept` attribute value for the upload input. */
export const UPLOAD_ACCEPT = [
    "image/*", "audio/*", "video/*", ".pdf",
    ...TEXT_LIKE_EXTENSIONS.map((e) => `.${e}`),
].join(",");

function getFileExtension(name: string): string {
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

/** Is this attachment plain text we can read by decoding it (vs. binary media)? */
export function isTextLikeAttachment(mimeType: string, name: string): boolean {
    if (mimeType && (mimeType.startsWith("text/") || SUPPORTED_MIME_TYPES.text.includes(mimeType))) {
        return true;
    }
    return TEXT_LIKE_EXTENSIONS.includes(getFileExtension(name));
}

/** Whether an upload is accepted at all (binary media by MIME, or text by MIME/extension). */
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
