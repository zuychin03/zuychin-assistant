

export interface Message {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    imageUrl?: string;
    channel: MessageChannel;
    createdAt: string;
}

export type MessageChannel = "web" | "whatsapp" | "messenger" | "instagram";

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
    base64: string;       // base64-encoded file data
    size: number;         // bytes
}

// Supported MIME types for Gemini multimodal
export const SUPPORTED_MIME_TYPES: Record<string, string[]> = {
    images: ["image/jpeg", "image/png", "image/webp", "image/heic"],
    audio: ["audio/mp3", "audio/mpeg", "audio/wav", "audio/flac", "audio/ogg", "audio/m4a", "audio/x-aac"],
    video: ["video/mp4", "video/quicktime", "video/webm"],
    documents: ["application/pdf"],
    text: ["text/plain", "text/csv", "text/html", "text/css", "text/javascript", "application/json", "application/xml"],
};

export const ALL_SUPPORTED_MIME_TYPES = Object.values(SUPPORTED_MIME_TYPES).flat();

export const MAX_FILE_SIZE_MB = 20;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export interface ChatResponse {
    reply: string;
    messageId: string;
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
    createdAt: string;
}
