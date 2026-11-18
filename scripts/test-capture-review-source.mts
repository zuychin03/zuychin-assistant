import assert from "node:assert/strict";
import { EXTRACT_LABEL, fillsSourceText, offersGemini, readableCapture, sourceStatus } from "../src/lib/capture/review-source";
import type { CaptureExtract, CaptureItem } from "../src/lib/capture/types";

const item = (kind: CaptureItem["source"]["kind"], url?: string): CaptureItem => ({ id: "11111111-1111-4111-8111-111111111111", profileId: "owner", sourceHash: "0".repeat(64),
    createdAt: "2026-11-18T00:00:00.000Z", receipt: null, source: { kind, title: "Fixture", text: "", ...(url ? { url } : {}) } });
const extract = (patch: Partial<CaptureExtract>): CaptureExtract => ({ version: 1, status: "ok", method: "html", text: "Body", truncated: false, words: 2340,
    fetchedAt: "2026-11-18T14:30:00.000Z", ...patch });
const link = item("link", "https://www.example.com/post"), pdf = item("pdf"), text = item("text");

assert.equal(readableCapture(link), true); assert.equal(readableCapture(pdf), true); assert.equal(readableCapture(text), false); assert.equal(readableCapture(item("offline_note")), false);

// 14:30 UTC on 18/11 is 01:30 on 19/11 in Sydney (AEDT).
assert.equal(sourceStatus(link, extract({ finalUrl: "https://www.example.com/post" }), ""), "Read 2,340 words from example.com on 19/11/2026.");
assert.equal(sourceStatus(link, extract({ finalUrl: "https://docs.example.org/final" }), ""), "Read 2,340 words from docs.example.org on 19/11/2026.");
assert.equal(sourceStatus(pdf, extract({ method: "pdf-text", words: 1, pages: 1 }), ""), "Read 1 word from the PDF (1 page) on 19/11/2026.");
assert.equal(sourceStatus(link, extract({ method: "pdf-text", pages: 15, finalUrl: "https://arxiv.org/pdf/1706.03762" }), ""), "Read 2,340 words from arxiv.org (15 pages) on 19/11/2026.");
assert.equal(sourceStatus(pdf, extract({ method: "ocr-free", pages: 2 }), ""), "Gemini (free) read 2,340 words from the PDF (2 pages) on 19/11/2026.");
assert.equal(sourceStatus(pdf, extract({ method: "ocr-paid", truncated: true, note: "Gemini stopped before the end of the PDF." }), ""),
    "Gemini (paid) read 2,340 words from the PDF on 19/11/2026. Gemini stopped before the end of the PDF.");
assert.match(sourceStatus(link, extract({ truncated: true }), ""), /Only the first 120,000 characters were kept\.$/);
assert.equal(sourceStatus(link, extract({ status: "empty", text: "", note: "This page had only 25 words of text. It may need JavaScript or a sign-in. Paste the passage if more is missing." }), ""),
    "This page had only 25 words of text. It may need JavaScript or a sign-in. Paste the passage if more is missing.");
assert.equal(sourceStatus(link, extract({ status: "blocked", text: "" }), ""), "This address isn't public, so Capture won't fetch it.");
assert.equal(sourceStatus(pdf, extract({ status: "scanned", method: "pdf-text", text: "" }), ""), "This PDF has no text layer. It looks scanned.");
assert.equal(sourceStatus(pdf, extract({ status: "locked", method: "pdf-text", text: "" }), ""), "This PDF needs a password.");
assert.equal(sourceStatus(pdf, extract({ status: "running", method: "ocr-free", text: "" }), ""), "Gemini is reading the scanned pages…");
assert.equal(sourceStatus(link, undefined, "read"), "Reading the page…");
assert.equal(sourceStatus(pdf, extract({}), "read"), "Reading the PDF…");
assert.equal(sourceStatus(pdf, extract({ status: "scanned" }), "free"), "Starting Gemini…");
assert.equal(sourceStatus(link, undefined, ""), "The page has not been fetched yet.");

assert.equal(offersGemini(pdf, extract({ status: "scanned", method: "pdf-text", text: "" })), true);
assert.equal(offersGemini(link, extract({ status: "scanned", method: "pdf-text", contentType: "application/pdf", text: "" })), true);
assert.equal(offersGemini(pdf, extract({ status: "failed", method: "ocr-free", text: "", note: "Gemini is busy right now. Try again in a few minutes." })), true);
assert.equal(offersGemini(pdf, extract({ status: "empty", method: "ocr-paid", text: "" })), true);
for (const value of [extract({ status: "ok", method: "pdf-text" }), extract({ status: "ok", method: "ocr-free" }), extract({ status: "running", method: "ocr-free" }),
    extract({ status: "locked", method: "pdf-text" }), extract({ status: "failed", method: "pdf-text" })]) assert.equal(offersGemini(pdf, value), false, `${value.status} ${value.method}`);
assert.equal(offersGemini(link, extract({ status: "empty", method: "html", text: "" })), false);
assert.equal(offersGemini(pdf, undefined), false);

assert.equal(fillsSourceText(extract({})), true);
assert.equal(fillsSourceText(extract({ status: "empty", text: "Twenty five words" })), true);
for (const value of [extract({ status: "scanned", text: "1 2" }), extract({ status: "failed", text: "" }), extract({ status: "ok", text: "" }), extract({ status: "running", text: "" })]) {
    assert.equal(fillsSourceText(value), false, value.status);
}
assert.deepEqual(Object.keys(EXTRACT_LABEL).sort(), ["blocked", "empty", "failed", "locked", "ok", "running", "scanned"]);
console.log("Capture review source: status lines (Sydney dates, hosts, pages, Gemini, notes), Gemini offers, source text filling and inbox labels passed.");
