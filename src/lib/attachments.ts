import type { FileAttachment } from "./types";

const MAX_TEXT_ATTACHMENT_CHARS = 120_000;

function getFileExtension(name: string): string {
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function decodeTextAttachment(file: FileAttachment): string {
    try {
        return Buffer.from(file.base64, "base64").toString("utf-8");
    } catch {
        return "";
    }
}

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
