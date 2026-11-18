export const SOURCE_TEXT_LIMIT = 120_000;
const CUT_NOTE = "\n\n_Source text cut at 120,000 characters._";

export const countWords = (text: string) => text.match(/\S+/g)?.length ?? 0;

function imagesToLinks(line: string): string {
    return line
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt: string, href: string) => `[Image: ${alt.trim() || "untitled"}](${href})`)
        .replace(/<img\b[^>]*>/gi, (tag) => {
            const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
            const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1]?.trim();
            return src ? `[Image: ${alt || "untitled"}](${src})` : "";
        });
}

// Stored documents load external images, and the capture title must stay the only H1.
export function tidyMarkdown(markdown: string): string {
    let fence: string | null = null;
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n").map((line) => {
        const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
        if (marker) {
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
            return line;
        }
        if (fence) return line;
        return imagesToLinks(line.replace(/^(#{1,6})(?=\s)/, (hashes) => "#".repeat(Math.min(6, hashes.length + 2)))).replace(/[ \t]+$/, "");
    });
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function capText(text: string, limit = SOURCE_TEXT_LIMIT): { text: string; truncated: boolean } {
    if (text.length <= limit) return { text, truncated: false };
    const room = limit - CUT_NOTE.length;
    let cut = text.lastIndexOf("\n\n", room);
    if (cut < room * 0.8) cut = room;
    return { text: text.slice(0, cut).trimEnd() + CUT_NOTE, truncated: true };
}

export function decodeText(body: Buffer, declared?: string): string {
    if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return new TextDecoder("utf-8").decode(body);
    if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder("utf-16le").decode(body);
    if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder("utf-16be").decode(body);
    const label = declared ?? body.subarray(0, 4096).toString("latin1").match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)?.[1];
    try { return new TextDecoder(label || "utf-8").decode(body); } catch { return new TextDecoder("utf-8").decode(body); }
}
