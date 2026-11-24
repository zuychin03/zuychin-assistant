import type { CaptureExtract, CaptureExtractStatus, CaptureItem, CaptureSource, OcrTier } from "./types";

export type SourceActivity = "" | "read" | "pages" | OcrTier;

/** Scanned PDFs over this many pages go to Gemini instead of the page reader. */
export const PAGE_READ_LIMIT = 30;

export const readableCapture = (item: CaptureItem) => item.source.kind === "link" || item.source.kind === "pdf" || item.source.kind === "image";

export const KIND_LABEL: Record<CaptureSource["kind"], string> = { text: "text", link: "link", pdf: "pdf", image: "photo", offline_note: "offline note" };

export const EXTRACT_LABEL: Record<CaptureExtractStatus, string> = {
    ok: "Text ready", empty: "No readable text", scanned: "Scanned PDF", locked: "Needs a password", blocked: "Not fetched", failed: "Read failed", running: "Gemini reading",
};

const FALLBACK: Record<Exclude<CaptureExtractStatus, "ok" | "running">, string> = {
    empty: "This page had no readable text. It may need JavaScript or a sign-in. Paste the passage instead.",
    scanned: "This PDF has no text layer. It looks scanned.", locked: "This PDF needs a password.",
    blocked: "This address isn't public, so Capture won't fetch it.", failed: "The source could not be read. Paste the passage instead.",
};

const count = (value: number, word: string) => `${value.toLocaleString("en-AU")} ${word}${value === 1 ? "" : "s"}`;
const day = (value: string) => new Date(value).toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "2-digit", year: "numeric" });
function hostName(value?: string) { try { return value ? new URL(value).hostname.replace(/^www\./, "") : ""; } catch { return ""; } }

export function sourceStatus(item: CaptureItem, extract: CaptureExtract | undefined, activity: SourceActivity): string {
    const photo = item.source.kind === "image";
    if (activity === "read") return photo ? "Reading the photo…" : item.source.kind === "pdf" ? "Reading the PDF…" : "Reading the page…";
    if (activity === "pages") return "Reading the pages…";
    if (activity) return "Starting Gemini…";
    if (!extract) return photo ? "The photo has not been read yet." : item.source.kind === "pdf" ? "The PDF has not been read yet." : "The page has not been fetched yet.";
    if (extract.status === "running") return photo ? "Gemini is reading the photo…" : "Gemini is reading the scanned pages…";
    if (extract.status !== "ok") return extract.note ?? FALLBACK[extract.status];
    if (extract.method === "caption") return `No text was found, so ${extract.model ?? "a vision model"} described the photo on ${day(extract.fetchedAt)}.`;
    const reader = extract.method === "ocr-free" ? "Gemini (free) read" : extract.method === "ocr-paid" ? "Gemini (paid) read"
        : extract.method === "parse" ? `${extract.model ?? "The page reader"} read` : "Read";
    const fromFile = extract.method.startsWith("ocr-") || extract.method === "parse";
    const from = photo ? "the photo" : (!fromFile && hostName(extract.finalUrl ?? item.source.url)) || "the PDF";
    const pages = extract.pages ? ` (${count(extract.pages, "page")})` : "";
    const extra = extract.note ? ` ${extract.note}` : extract.truncated ? " Only the first 120,000 characters were kept." : "";
    return `${reader} ${count(extract.words, "word")} from ${from}${pages} on ${day(extract.fetchedAt)}.${extra}`;
}

// The server lets Gemini read any PDF or photo; these are the cases where the page offers it.
export function offersGemini(item: CaptureItem, extract: CaptureExtract | undefined): boolean {
    if (!extract || extract.status === "running") return false;
    if (item.source.kind === "image") return extract.status !== "ok" || extract.method === "caption";
    const pdf = item.source.kind === "pdf" || extract.contentType === "application/pdf" || extract.method === "pdf-text" || extract.method.startsWith("ocr-");
    return pdf && (extract.status === "scanned" || ((extract.method.startsWith("ocr-") || extract.method === "parse") && extract.status !== "ok"));
}

/** One page of a scanned PDF under its marker; the reader's headings (already H3 and below) move one level under it. */
export function pageSection(number: number, markdown: string | null): string {
    let fenced = false;
    const body = markdown === null ? "[This page could not be read.]" : markdown.split("\n").map((line) => {
        if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fenced = !fenced;
        return fenced ? line : line.replace(/^(#{1,5})(?=\s)/, "$1#");
    }).join("\n");
    return `### Page ${number}\n\n${body}`;
}

/** Read pages (free) needs the stored PDF, so linked PDFs keep Gemini only. */
export const offersPageReading = (item: CaptureItem, extract: CaptureExtract | undefined) => item.source.kind === "pdf" && offersGemini(item, extract);

// Fetched text fills the box only when it is usable; scanned fragments and failures leave it as it is.
export const fillsSourceText = (extract: CaptureExtract) => (extract.status === "ok" || extract.status === "empty") && !!extract.text;
