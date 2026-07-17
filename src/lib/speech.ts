// Markdown → speakable plain text for the TTS pipeline. Kept free of
// server-only imports so client code could share it if ever needed.

export function stripMarkdown(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " (code omitted) ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/[*_~#>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
