const KB = 1024;
const MB = 1024 * KB;

/** Next's proxyClientMaxBodySize (next.config.ts). Over it Next silently passes only the first bytes on. */
export const NEXT_BODY_LIMIT = 10 * MB;
/** A 7 MiB file as base64 (9,786,712 bytes) plus a 10,000-character message fits; still under NEXT_BODY_LIMIT. */
export const CHAT_BODY_LIMIT = 10_000_000;
export const DEFAULT_BODY_LIMIT = 1 * MB;
/** STT_MAX_BYTES in src/lib/voice/stt-client.ts: 60 s of 16 kHz 16-bit PCM. */
export const VOICE_BODY_LIMIT = 1_920_000;

// Every limit stays under NEXT_BODY_LIMIT, so a body Next cut short is always over its limit: a 413, never a parse error.
export const BODY_LIMIT_RULES: readonly { path: string; prefix?: true; limit: number }[] = [
    { path: "/api/auth", limit: 64 * KB },
    { path: "/api/auth/passkey", limit: 64 * KB },
    { path: "/api/auth/totp", limit: 64 * KB },
    { path: "/api/auth/sessions", limit: 64 * KB },
    { path: "/api/agent/claim", limit: 64 * KB },
    { path: "/api/chat/preferences", limit: 64 * KB },
    { path: "/api/push/subscribe", limit: 64 * KB },
    { path: "/api/cron", prefix: true, limit: 64 * KB },
    { path: "/api/telegram/webhook", limit: 2 * MB },
    { path: "/api/knowledge/webhook", limit: 2 * MB },
    { path: "/api/capture", limit: 3_000_000 },
    { path: "/api/voice/transcribe", limit: VOICE_BODY_LIMIT },
    { path: "/api/mcp", prefix: true, limit: 4 * MB },
    { path: "/api/vault/page", limit: 4 * MB },
    { path: "/api/knowledge/documents", limit: 4 * MB },
    { path: "/api/export", limit: 4 * MB },
    { path: "/api/chat", limit: CHAT_BODY_LIMIT },
    { path: "/api/chat/stream", limit: CHAT_BODY_LIMIT },
    { path: "/api/knowledge/import", limit: CHAT_BODY_LIMIT },
];

export function bodyLimit(pathname: string): number {
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    for (const rule of BODY_LIMIT_RULES) {
        if (path === rule.path || (rule.prefix && path.startsWith(`${rule.path}/`))) return rule.limit;
    }
    return DEFAULT_BODY_LIMIT;
}

export function describeLimit(bytes: number): string {
    if (bytes >= MB) return `${Math.floor((bytes / MB) * 10) / 10} MB`;
    return `${Math.floor(bytes / KB)} KB`;
}
