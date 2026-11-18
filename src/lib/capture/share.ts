import type { CaptureSource } from "./types";

const LINK = /https?:\/\/[^\s<>"']+/i;
const TRAILING = /[),.;:!?'"\]]+$/;

// Android often puts the shared URL inside `text` and leaves `url` empty.
export function sharedCapture(params: URLSearchParams): CaptureSource | null {
    const title = (params.get("title") ?? "").trim(), text = (params.get("text") ?? "").trim(), url = (params.get("url") ?? "").trim();
    if (!title && !text && !url) return null;
    const found = /^https?:\/\//i.test(url) ? url : text.match(LINK)?.[0] ?? "", link = found.replace(TRAILING, "");
    if (!link) return { kind: "text", title: title.slice(0, 200), text: text.slice(0, 120_000) };
    const rest = text.split(found).join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    // What is left can be just the brackets or full stop around the link.
    const notes = /[\p{L}\p{N}]/u.test(rest) ? rest : "";
    return { kind: "link", title: title.slice(0, 200), text: notes.slice(0, 120_000), url: link };
}
