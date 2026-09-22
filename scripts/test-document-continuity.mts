import assert from "node:assert/strict";
import { acknowledgeDocumentSave, discardDocumentDraft, readDocumentDraft, writeDocumentDraft, type DraftStorage } from "../src/lib/document-drafts.ts";
import { libraryDocumentDestination, safeReturnTo, withReturnTo } from "../src/lib/document-navigation.ts";

const data = new Map<string, string>();
const storage: DraftStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
};
let cases = 0;
function check(name: string, run: () => void) { run(); cases++; console.log(`Pass: ${name}`); }

check("document drafts stay separate across Library and Cosmos", () => {
    writeDocumentDraft("wiki/sources/fixture-a.md", "A", "A draft", storage);
    writeDocumentDraft("wiki/sources/fixture-b.md", "B", "B draft", storage);
    assert.equal(readDocumentDraft("wiki/sources/fixture-a.md", storage)?.text, "A draft");
    assert.equal(readDocumentDraft("wiki/sources/fixture-b.md", storage)?.text, "B draft");
});
check("save completion cannot erase text typed during the request", () => {
    writeDocumentDraft("wiki/sources/fixture-a.md", "A", "Newer edit", storage);
    acknowledgeDocumentSave("wiki/sources/fixture-a.md", "A draft", "Server-normalised A draft", storage);
    assert.equal(readDocumentDraft("wiki/sources/fixture-a.md", storage)?.text, "Newer edit");
    assert.equal(readDocumentDraft("wiki/sources/fixture-a.md", storage)?.base, "Server-normalised A draft");
});
check("successful save clears only the submitted document", () => {
    acknowledgeDocumentSave("wiki/sources/fixture-a.md", "Newer edit", "Newer edit", storage);
    assert.equal(readDocumentDraft("wiki/sources/fixture-a.md", storage), null);
    assert.equal(readDocumentDraft("wiki/sources/fixture-b.md", storage)?.text, "B draft");
});
check("explicit discard preserves the saved source and other drafts", () => {
    assert.equal(discardDocumentDraft("wiki/sources/fixture-b.md", storage), true);
    assert.equal(readDocumentDraft("wiki/sources/fixture-b.md", storage), null);
});
check("storage failures retain an in-memory recovery copy", () => {
    const unavailable: DraftStorage = { getItem: () => { throw Error("disabled"); }, setItem: () => { throw Error("quota"); }, removeItem: () => { throw Error("disabled"); } };
    assert.equal(writeDocumentDraft("wiki/sources/fixture-offline.md", "Source", "Unsaved", unavailable), false);
    assert.equal(readDocumentDraft("wiki/sources/fixture-offline.md", unavailable)?.text, "Unsaved");
    assert.equal(discardDocumentDraft("wiki/sources/fixture-offline.md"), false);
    assert.equal(readDocumentDraft("wiki/sources/fixture-offline.md")?.text, "Unsaved");
    assert.equal(discardDocumentDraft("wiki/sources/fixture-offline.md", unavailable), false);
    assert.equal(readDocumentDraft("wiki/sources/fixture-offline.md", unavailable)?.text, "Unsaved");
});
check("same-millisecond failed writes cannot restore stale disk text", () => {
    const originalNow = Date.now;
    Date.now = () => 42;
    try {
        writeDocumentDraft("fixture-quota", "Base", "Persisted old draft", storage);
        const failedWrite: DraftStorage = { ...storage, setItem: () => { throw Error("quota"); } };
        writeDocumentDraft("fixture-quota", "Base", "Newest unsaved edit", failedWrite);
        assert.equal(readDocumentDraft("fixture-quota", failedWrite)?.text, "Newest unsaved edit");
        assert.equal(readDocumentDraft("fixture-quota", failedWrite)?.updatedAt, 43);
    } finally { Date.now = originalNow; }
});
check("invalid stored data cannot become another document's draft", () => {
    data.set("zuychin:document-draft:v1:fixture-invalid", '{"version":1,"path":"other","text":"wrong","base":"base","updatedAt":1}');
    assert.equal(readDocumentDraft("fixture-invalid", storage), null);
    data.set("zuychin:document-draft:v1:fixture-invalid", "invalid json");
    assert.equal(readDocumentDraft("fixture-invalid", storage), null);
});
check("return links reject external and API targets", () => {
    for (const value of ["https://evil.invalid", "//evil.invalid", "/\\evil.invalid", "/api/vault/page", "javascript:alert(1)", "/knowledge\n"]) assert.equal(safeReturnTo(value), null);
});
check("return links retain chat selection without recursive navigation", () => {
    assert.equal(safeReturnTo("/?c=fixture-chat&returnTo=%2Fgraph"), "/?c=fixture-chat");
    const destination = new URL(withReturnTo("/knowledge?tab=timeline", "/?c=fixture-chat"), "https://local.invalid");
    assert.equal(destination.searchParams.get("tab"), "timeline");
    assert.equal(destination.searchParams.get("returnTo"), "/?c=fixture-chat");
});
check("returning to the same Library page preserves tab context and filters", () => {
    const url = new URL(libraryDocumentDestination("wiki/sources/a.md", "/knowledge?document=doc-a&path=wiki%2Fsources%2Fa.md&filter=RAG&status=archived&view=pages&tab=timeline", "evidence"), "https://local.invalid");
    assert.equal(url.searchParams.get("document"), "doc-a");
    assert.equal(url.searchParams.get("filter"), "RAG");
    assert.equal(url.searchParams.get("status"), "archived");
    assert.equal(url.searchParams.get("section"), "evidence");
    assert.equal(url.searchParams.has("view"), false);
    assert.equal(url.searchParams.has("tab"), false);
});
check("opening a different Cosmos page cannot retain a stale Library identity", () => {
    const url = new URL(libraryDocumentDestination("wiki/sources/b.md", "/knowledge?document=doc-a&path=wiki%2Fsources%2Fa.md&filter=RAG"), "https://local.invalid");
    assert.equal(url.searchParams.has("document"), false);
    assert.equal(url.searchParams.get("path"), "wiki/sources/b.md");
    assert.equal(url.searchParams.get("status"), "all");
    assert.equal(url.searchParams.get("filter"), "RAG");
});
console.log(`Document continuity: ${cases} cases passed; fixture data only.`);
