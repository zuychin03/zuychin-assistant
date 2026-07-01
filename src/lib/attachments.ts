import type { FileAttachment } from "./types";

// Cap how much decoded text we inject into a prompt so a large upload can't blow
// the model's context window. Generous enough for typical config/data files.
const MAX_TEXT_ATTACHMENT_CHARS = 120_000;

function getFileExtension(name: string): string {
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

/** Decode a base64 attachment to a UTF-8 string (server-side only). */
export function decodeTextAttachment(file: FileAttachment): string {
    try {
        return Buffer.from(file.base64, "base64").toString("utf-8");
    } catch {
        return "";
    }
}

/**
 * Render a text-like attachment as a fenced code block the model can read,
 * regardless of provider (works for both the native and OpenAI-compatible paths).
 */
export function formatTextAttachment(file: FileAttachment): string {
    let text = decodeTextAttachment(file);
    let note = "";
    if (text.length > MAX_TEXT_ATTACHMENT_CHARS) {
        text = text.slice(0, MAX_TEXT_ATTACHMENT_CHARS);
        note = `\n… [truncated — original file is ${(file.size / 1024).toFixed(0)} KB]`;
    }
    const lang = getFileExtension(file.name);
    return `The user attached a file named "${file.name}". Its full contents are below:\n\n\`\`\`${lang}\n${text}${note}\n\`\`\``;
}
