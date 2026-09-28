import assert from "node:assert/strict";
import { createRevisionService, type RevisionDocument, type RevisionDependencies } from "../src/lib/knowledge/revisions";
import { hashContent } from "../src/lib/knowledge/markdown";

const oldSha = "a".repeat(40), currentSha = "b".repeat(40), newSha = "c".repeat(40);
const path = "wiki/concepts/example.md";
const historical = "---\nzuychin_id: doc-1\nscope: user\ntrust: trusted\n---\n# Example\n\nOlder supported claim.\n";
const current = "---\nzuychin_id: doc-1\nscope: project\nproject_id: project-1\ntrust: untrusted\nstatus: archived\nsensitivity: secret\n---\n# Example\n\nCurrent claim.\n";
const document: RevisionDocument = { id: "doc-1", path, title: "Example", summary: "", category: "concepts", scope: "project", trust: "untrusted", status: "archived", sensitivity: "secret", project_id: "project-1" };
function fixture() {
    let head = currentSha;
    const files = new Map([[oldSha, historical], [currentSha, current]]);
    let writes = 0, indexFails = false;
    const events: Record<string, unknown>[] = [];
    const deps: RevisionDependencies = {
        getDocument: async (id) => id === document.id ? document : null,
        getHead: async () => head,
        getFile: async (requestedPath, sha) => files.has(sha) && requestedPath === path ? { text: files.get(sha)!, sha: sha.slice(0, 39) + "0" } : null,
        isAncestor: async (sha) => files.has(sha),
        list: async () => ({ revisions: [{ commitSha: oldSha, path, committedAt: "2026-09-01T00:00:00Z", message: "Earlier version", author: "Fixture" }], hasMore: false }),
        commit: async (changes, expectedHead) => {
            assert.equal(expectedHead, head);
            assert.equal(changes.length, 1);
            files.set(newSha, changes[0].content!); head = newSha; writes++;
            return { commit: newSha };
        },
        index: async () => { if (indexFails) throw new Error("offline index"); },
        recordEvent: async (event) => { events.push(event); },
    };
    return { service: createRevisionService(deps), files, events, writes: () => writes, changeHead: () => { head = "d".repeat(40); }, failIndex: () => { indexFails = true; } };
}
let checks = 0;
async function check(name: string, run: () => Promise<void>) { await run(); checks++; console.log(`PASS ${name}`); }
await check("preview highlights restored passages and preserves current security metadata", async () => {
    const f = fixture();
    const preview = await f.service.preview({ documentId: "doc-1", sourceSha: oldSha });
    assert.match(preview.restoredMarkdown, /Older supported claim/);
    assert.match(preview.restoredMarkdown, /scope: project/);
    assert.match(preview.restoredMarkdown, /trust: untrusted/);
    assert.match(preview.restoredMarkdown, /status: archived/);
    assert.match(preview.restoredMarkdown, /sensitivity: secret/);
    assert.ok(preview.diff.some((line) => line.kind === "removed" && line.text.includes("Current claim")));
    assert.ok(preview.diff.some((line) => line.kind === "added" && line.text.includes("Older supported")));
    assert.equal(f.writes(), 0);
});
await check("restore appends a revision and records the immutable source", async () => {
    const f = fixture(); const preview = await f.service.preview({ documentId: "doc-1", sourceSha: oldSha });
    const result = await f.service.restore(preview);
    assert.equal(result.commit, newSha);
    assert.equal(result.indexed, true);
    assert.equal(f.files.get(oldSha), historical);
    assert.equal(f.files.get(currentSha), current);
    assert.equal(f.files.get(newSha), preview.restoredMarkdown);
    assert.equal(f.events[0].sourceSha, oldSha);
});
await check("stale preview or modified preview is rejected without writes", async () => {
    const f = fixture(); const preview = await f.service.preview({ documentId: "doc-1", sourceSha: oldSha });
    await assert.rejects(f.service.restore({ ...preview, previewHash: "0".repeat(64) }), /preview/i);
    assert.equal(f.writes(), 0);
    f.changeHead();
    await assert.rejects(f.service.restore(preview), /changed/i);
    assert.equal(f.writes(), 0);
});
await check("post-commit index failure reports committed revision without pretending rollback", async () => {
    const f = fixture(); f.failIndex(); const preview = await f.service.preview({ documentId: "doc-1", sourceSha: oldSha });
    const result = await f.service.restore(preview);
    assert.equal(result.commit, newSha); assert.equal(result.indexed, false); assert.match(result.warning!, /index/i);
    assert.equal(f.writes(), 1);
});
await check("evidence is pinned to exact immutable quote and full content", async () => {
    const f = fixture();
    const evidence = await f.service.evidence({ documentId: "doc-1", commitSha: oldSha, quote: "Older supported claim." });
    assert.equal(evidence.path, path); assert.equal(evidence.commitSha, oldSha);
    assert.equal(evidence.contentHash, hashContent(historical)); assert.equal(evidence.quoteHash, hashContent(evidence.quote));
    assert.equal(historical.slice(evidence.startOffset, evidence.endOffset), evidence.quote);
    await assert.rejects(f.service.evidence({ documentId: "doc-1", commitSha: oldSha, quote: "Invented claim" }), /passage/i);
    await assert.rejects(f.service.evidence({ documentId: "doc-1", commitSha: "main", quote: "Older supported claim." }), /revision/i);
});
await check("duplicate quotations require explicit UTF-16 offsets", async () => {
    const f = fixture(); const text = historical + "😀 Older supported claim.\n"; f.files.set(oldSha, text);
    await assert.rejects(f.service.evidence({ documentId: "doc-1", commitSha: oldSha, quote: "Older supported claim." }), /ambiguous/i);
    const offset = text.lastIndexOf("Older supported claim.");
    const evidence = await f.service.evidence({ documentId: "doc-1", commitSha: oldSha, quote: "Older supported claim.", startOffset: offset });
    assert.equal(evidence.startOffset, offset);
    assert.equal(text.slice(evidence.startOffset, evidence.endOffset), evidence.quote);
});
await check("stale catalogue identity cannot restore over a replacement document", async () => {
    const f = fixture(); f.files.set(currentSha, current.replace("doc-1", "doc-2"));
    await assert.rejects(f.service.preview({ documentId: "doc-1", sourceSha: oldSha }), /different document/i);
    assert.equal(f.writes(), 0);
});
console.log(`${checks} knowledge revision checks passed with an offline repository.`);
