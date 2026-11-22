// Markdown → speakable plain text for the TTS pipeline. Kept free of
// server-only imports so client code could share it if ever needed.

export function stripMarkdown(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " (code omitted) ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
        .replace(/^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/gm, "")
        .replace(/[*_~#>|]/g, "")
        // Lines stay separate: the speech service ends each one as a sentence, the only full stop most list items and headings get.
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => /[\p{L}\p{N}]/u.test(line))
        .join("\n");
}
