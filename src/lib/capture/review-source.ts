import type { CaptureExtract, CaptureExtractStatus, CaptureItem, OcrTier } from "./types";

export type SourceActivity = "" | "read" | OcrTier;

export const readableCapture = (item: CaptureItem) => item.source.kind === "link" || item.source.kind === "pdf";

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
    if (activity === "read") return item.source.kind === "pdf" ? "Reading the PDF…" : "Reading the page…";
    if (activity) return "Starting Gemini…";
    if (!extract) return item.source.kind === "pdf" ? "The PDF has not been read yet." : "The page has not been fetched yet.";
    if (extract.status === "running") return "Gemini is reading the scanned pages…";
    if (extract.status !== "ok") return extract.note ?? FALLBACK[extract.status];
    const reader = extract.method === "ocr-free" ? "Gemini (free) read" : extract.method === "ocr-paid" ? "Gemini (paid) read" : "Read";
    const from = (!extract.method.startsWith("ocr-") && hostName(extract.finalUrl ?? item.source.url)) || "the PDF";
    const pages = extract.pages ? ` (${count(extract.pages, "page")})` : "";
    const extra = extract.note ? ` ${extract.note}` : extract.truncated ? " Only the first 120,000 characters were kept." : "";
    return `${reader} ${count(extract.words, "word")} from ${from}${pages} on ${day(extract.fetchedAt)}.${extra}`;
}

// Matches the server's rule for which captures Gemini may read.
export function offersGemini(item: CaptureItem, extract: CaptureExtract | undefined): boolean {
    if (!extract || extract.status === "running") return false;
    const pdf = item.source.kind === "pdf" || extract.contentType === "application/pdf" || extract.method === "pdf-text" || extract.method.startsWith("ocr-");
    return pdf && (extract.status === "scanned" || (extract.method.startsWith("ocr-") && extract.status !== "ok"));
}

// Fetched text fills the box only when it is usable; scanned fragments and failures leave it as it is.
export const fillsSourceText = (extract: CaptureExtract) => (extract.status === "ok" || extract.status === "empty") && !!extract.text;
