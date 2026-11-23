import assert from "node:assert/strict";
import { test } from "node:test";
import { embedPastScreen, isScreenRefusal, urlsToHosts } from "../src/lib/ai/embedding-screening.ts";

const refusal = () => Object.assign(new Error('Embedding request failed (NVIDIA NIM 422): {"error": {"message": "input rejected by content safety screening"}}'), { status: 422 });
const vectorFor = (text: string) => [text.length, 1, 0];

function fake(refuses: (text: string) => boolean) {
    const calls: string[] = [];
    const embed = async (text: string) => {
        calls.push(text);
        if (refuses(text)) throw refusal();
        return vectorFor(text);
    };
    return { calls, embed };
}

test("only the provider's screen refusal counts", () => {
    assert.equal(isScreenRefusal(refusal()), true);
    assert.equal(isScreenRefusal(Object.assign(new Error("Embedding request failed (NVIDIA NIM 422): bad input"), { status: 422 })), false);
    assert.equal(isScreenRefusal(Object.assign(new Error("content safety screening"), { status: 410 })), false);
    assert.equal(isScreenRefusal("content safety screening"), false);
});

test("URLs are cut to their host and other text is kept", () => {
    assert.equal(urlsToHosts("see https://github.com/owner/repo, then (http://example.com/a?b=1)"), "see github.com, then (example.com)");
    assert.equal(urlsToHosts("no links here"), "no links here");
});

test("accepted text is embedded once", async () => {
    const f = fake(() => false);
    assert.deepEqual(await embedPastScreen("plain text", f.embed), vectorFor("plain text"));
    assert.deepEqual(f.calls, ["plain text"]);
});

test("other errors pass through without fallbacks", async () => {
    const calls: string[] = [];
    const gone = Object.assign(new Error("Embedding request failed (NVIDIA NIM 410): gone"), { status: 410 });
    await assert.rejects(embedPastScreen("a\n\nb", async (text) => { calls.push(text); throw gone; }), (error) => error === gone);
    assert.deepEqual(calls, ["a\n\nb"]);
});

test("a refused link is retried with its host", async () => {
    const f = fake((text) => text.includes("https://"));
    const text = "https://github.com/owner/repo";
    assert.deepEqual(await embedPastScreen(text, f.embed), vectorFor("github.com"));
    assert.deepEqual(f.calls, [text, "github.com"]);
});

test("paragraphs the screen refuses are left out", async () => {
    const f = fake((text) => text.includes("BAD"));
    const text = "Title\n\nfirst point\n\nBAD paragraph\n\nlast point";
    assert.deepEqual(await embedPastScreen(text, f.embed), vectorFor("Title\n\nfirst point\n\nlast point"));
    assert.deepEqual(f.calls, [text, "Title", "first point", "BAD paragraph", "last point", "Title\n\nfirst point\n\nlast point"]);
});

test("a single surviving paragraph reuses its vector", async () => {
    const f = fake((text) => text.includes("BAD"));
    assert.deepEqual(await embedPastScreen("keep\n\nBAD", f.embed), vectorFor("keep"));
    assert.deepEqual(f.calls, ["keep\n\nBAD", "keep", "BAD"]);
});

test("text refused whole and in every part is still refused", async () => {
    const all = fake(() => true);
    await assert.rejects(embedPastScreen("one\n\ntwo", all.embed), (error) => isScreenRefusal(error));
    const single = fake(() => true);
    await assert.rejects(embedPastScreen("one paragraph", single.embed), (error) => isScreenRefusal(error));
    assert.deepEqual(single.calls, ["one paragraph"]);
    const together = fake((text) => text.includes("\n\n"));
    await assert.rejects(embedPastScreen("one\n\ntwo", together.embed), (error) => isScreenRefusal(error));
    assert.deepEqual(together.calls, ["one\n\ntwo", "one", "two"]);
});
