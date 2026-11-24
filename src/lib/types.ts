export interface Message {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    imageUrl?: string;
    channel: MessageChannel;
    createdAt: string;
    metadata?: MessageMetadata;
}

export type ArtifactKind = "document" | "code" | "archive" | "image";

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

export function parseReplyRef(raw: unknown, maxChars = 2000): ReplyRef | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const { role, content } = raw as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) return undefined;
    return { role, content: content.slice(0, maxChars) };
}

/**
 * A council Zuychin has drafted but not created. Nothing exists server-side
 * until the user launches it: no session, no TTL, no open-council slot. Only a
 * loopback host can start one, and Zuychin runs on Vercel, so the browser is
 * the courier.
 */
export interface CouncilProposal {
    topic: string;
    brief: string;
    /** modelKey and source are set on online proposals, where each seat is a model. */
    participants: { name: string; expertise: string; modelKey?: string; source?: string }[];
    closerName: string;
    councilType: string;
    maxRounds?: number;
    /** Seats are chat models the server runs; started from the card with no host. */
    online?: boolean;
    allowPaid?: boolean;
    purpose?: string;
    /** Research first: searches the server runs once before round 1. */
    research?: { web: boolean; notes: boolean; query?: string };
}

/** A send the model asked for in a web chat turn, waiting for the owner's Approve or Reject. */
export interface HeldApproval {
    id: string;
    label: string;
    lines: string[];
    expiresAt: string;
}

export interface MessageMetadata {
    artifacts?: ArtifactDescriptor[];
    replyTo?: ReplyRef;
    councilProposal?: CouncilProposal;
    approvals?: HeldApproval[];
    [key: string]: unknown;
}

export type MessageChannel = "web" | "discord" | "telegram";
export const MESSAGE_CHANNELS: readonly MessageChannel[] = ["web", "discord", "telegram"];
export const isMessageChannel = (value: unknown): value is MessageChannel => MESSAGE_CHANNELS.includes(value as MessageChannel);
export const CHANNEL_NAMES: Record<MessageChannel, string> = { web: "the web app", telegram: "Telegram", discord: "Discord" };

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

// 7 MiB as base64 JSON stays under the chat body limit (src/lib/http/limits.ts) and Next's 10 MB cut-off.
export const MAX_FILE_SIZE_MB = 7;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/** Decoded size of base64 text without decoding it; the client's own size field is not trusted. */
export function base64Bytes(value: unknown): number {
    if (typeof value !== "string") return 0;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

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
