import assert from "node:assert/strict";
import { createCaptureService, validateCaptureSource } from "../src/lib/capture/service";
import type { CaptureItem } from "../src/lib/capture/types";

const id = "11111111-1111-4111-8111-111111111111", profile = "owner-1";
const rows = new Map<string, CaptureItem>(), files = new Map<string, string>();
const claims = new Map<string, { path: string; contentHash: string }>();
let head = "a".repeat(40), commits = 0, failIndex = false, failReceipt = false;
const service = createCaptureService({
    get: async (owner, key) => rows.get(`${owner}:${key}`) ?? null,
    insert: async (item) => { const key = `${item.profileId}:${item.id}`; if (!rows.has(key)) rows.set(key, item); return rows.get(key)!; },
    receipt: async (owner, key, receipt) => { if (failReceipt) throw new Error("lost receipt"); rows.get(`${owner}:${key}`)!.receipt = receipt; },
    claim: async (owner, key, claim) => { const claimKey = `${owner}:${key}`; if (!claims.has(claimKey)) claims.set(claimKey, claim); return claims.get(claimKey)!; },
    head: async () => head, read: async (path) => files.get(path) ?? null,
    commit: async (changes, expected) => { assert.equal(expected, head); changes.forEach(change => files.set(change.path, change.content ?? change.contentBase64!)); head = "b".repeat(40); commits++; return { commit: head }; },
    index: async () => { if (failIndex) throw new Error("fixture"); },
});
const source = { kind: "text" as const, title: "A passage", text: "Saved exact passage." };
await service.capture(profile, id, source);
await service.capture(profile, id, source);
assert.equal(rows.size, 1);
await assert.rejects(service.capture(profile, id, { ...source, text: "Altered replay" }), /different/i);
assert.equal(commits, 0);
await assert.rejects(service.preview("other", id, { title: "Review", text: source.text, destination: "notes/review.md" }), /not found/i);
const preview = await service.preview(profile, id, { title: "Review", text: source.text, destination: "notes/review.md" });
assert.match(preview.markdown, /trust: untrusted/); assert.equal(commits, 0);
await assert.rejects(service.ingest(profile, { ...preview, previewHash: "0".repeat(64) }), /preview/i);
failIndex = true;
const receipt = await service.ingest(profile, preview);
assert.equal(receipt.indexed, false); assert.equal(commits, 1);
assert.equal((await service.ingest(profile, preview)).commit, receipt.commit); assert.equal(commits, 1);
files.set(preview.path, "Newer source content");
await assert.rejects(service.preview(profile, id, preview.review), /exists|changed/i);
await assert.rejects(service.preview(profile, id, { ...preview.review, destination: "../secret.md" }), /path|destination/i);
assert.throws(() => validateCaptureSource({ kind: "link", title: "bad", text: "", url: "javascript:alert(1)" }), /URL/i);
assert.throws(() => validateCaptureSource({ kind: "pdf", title: "bad", text: "", pdf: { name: "x.pdf", base64: Buffer.from("not pdf").toString("base64") } }), /PDF/i);
const pdf = validateCaptureSource({ kind: "pdf", title: "PDF", text: "Reviewed passage", pdf: { name: "source.pdf", base64: Buffer.from("%PDF-1.4\nfixture").toString("base64") } });
assert.equal(pdf.pdf?.name, "source.pdf");
const replayId = "22222222-2222-4222-8222-222222222222";
await service.capture(profile, replayId, source);
const original = await service.preview(profile, replayId, { title: "Replay", text: "Reviewed", destination: "notes/original.md" });
failReceipt = true;
await service.ingest(profile, original);
const written = commits;
const moved = await service.preview(profile, replayId, { ...original.review, destination: "notes/duplicate.md" });
await assert.rejects(service.ingest(profile, moved), /reserved/i);
assert.equal(commits, written); assert.equal(files.has("notes/duplicate.md"), false);
failReceipt = false;
await service.ingest(profile, original); assert.equal(commits, written);
console.log("Capture inbox: replay, authorisation, review, safe ingestion, index failure, conflicts and PDF validation passed.");
