import assert from "node:assert/strict";

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://extras-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-gemini", AUTH_SESSION_SECRET: "fixture-session-secret", AUTH_ORIGIN: "https://assistant.test", NEXT_PUBLIC_BASE_URL: "",
    TAVILY_API_KEY: "fixture-quick", TAVILY_API_KEY_DEEP: "fixture-deep", CAPTURE_FETCH: "",
});

type TavilyCall = { key: string | null; body: Record<string, unknown> };
const tavilyCalls: TavilyCall[] = [];
let tavilyReply: (call: TavilyCall) => Response = () => Response.json({ results: [] });
globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://api.tavily.com/extract") {
        const call = { key: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
        tavilyCalls.push(call);
        return tavilyReply(call);
    }
    throw new Error(`Unexpected offline request to ${url.href}`);
};

const { safeNextPath, loginSearch } = await import("../src/lib/auth/next-path");
const { sharedCapture } = await import("../src/lib/capture/share");
const { NextRequest } = await import("next/server");
const { proxy } = await import("../src/proxy");
const { tavilyExtract } = await import("../src/lib/ai/web-search");
const { extractCapture } = await import("../src/lib/capture/extract/index");
const { SourceFetchError } = await import("../src/lib/capture/fetch/http");
const { CaptureError, validateCaptureSource } = await import("../src/lib/capture/service");
const { executeCaptureAdd } = await import("../src/lib/capture/chat-tool");
const { unattendedDisposition, confirmedActionReceipt } = await import("../src/lib/tasks/unattended-policy");
const { freeToolRefusal } = await import("../src/lib/ai/model-policy");
const { MCP_TOOLS, READ_ONLY_TOOLS } = await import("../src/lib/ai/mcp-service");

let passed = 0;
async function check(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`ok - ${name}`); }

await check("sign-in returns only to same-site relative paths", () => {
    assert.equal(safeNextPath("/capture?url=x"), "/capture?url=x");
    assert.equal(safeNextPath("/capture?url=https%3A%2F%2Fexample.com%2Fa&title=A#top"), "/capture?url=https%3A%2F%2Fexample.com%2Fa&title=A#top");
    for (const bad of ["//evil.example", "/\\evil.example", "https://x", "javascript:alert(1)", "/capture\nx", "/capture\x00", "/\tx", "", null, undefined,
        "capture", "/login", "/login?next=/x", "/login/", `/${"a".repeat(2100)}`]) assert.equal(safeNextPath(bad), "/", JSON.stringify(bad));
});

await check("a signed-out page visit carries its path and query to sign-in; API redirects do not", async () => {
    assert.equal(loginSearch("/", ""), "");
    assert.equal(loginSearch("/capture", "?url=x"), "?next=%2Fcapture%3Furl%3Dx");
    const visit = async (path: string, method = "GET") => {
        const res = await proxy(new NextRequest(`https://assistant.test${path}`, { method }));
        assert.equal(res.status, 307, path);
        return new URL(res.headers.get("location")!);
    };
    const shared = await visit("/capture?url=https%3A%2F%2Fexample.com%2Fpost&title=Post");
    assert.equal(shared.pathname, "/login");
    assert.equal(safeNextPath(shared.searchParams.get("next")), "/capture?url=https%3A%2F%2Fexample.com%2Fpost&title=Post");
    assert.equal((await visit("/")).search, "");
    const api = await visit("/api/capture?x=1");
    assert.equal(api.pathname, "/login"); assert.equal(api.searchParams.get("next"), null);
});

await check("share parameters become a link or a passage, never a save", () => {
    const params = (value: Record<string, string>) => new URLSearchParams(value);
    assert.equal(sharedCapture(params({})), null);
    assert.deepEqual(sharedCapture(params({ title: "Post", text: "Worth a read https://example.com/post?a=1." })),
        { kind: "link", title: "Post", text: "Worth a read", url: "https://example.com/post?a=1" });
    assert.deepEqual(sharedCapture(params({ title: "Post", text: "My note", url: "https://example.com/post" })),
        { kind: "link", title: "Post", text: "My note", url: "https://example.com/post" });
    assert.deepEqual(sharedCapture(params({ text: "(https://example.com/a)" })), { kind: "link", title: "", text: "", url: "https://example.com/a" });
    assert.deepEqual(sharedCapture(params({ title: "Quote", text: "A passage with no link." })), { kind: "text", title: "Quote", text: "A passage with no link." });
    assert.deepEqual(sharedCapture(params({ url: "javascript:alert(1)", text: "plain" })), { kind: "text", title: "", text: "plain" });
});

const body = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
await check("Tavily Extract reads a page, reports failures, and parks a refused pool", async () => {
    tavilyReply = () => Response.json({ results: [{ url: "https://example.com/a", raw_content: "# Title\n\nPage text" }], failed_results: [] });
    assert.deepEqual(await tavilyExtract("https://example.com/a"), { text: "# Title\n\nPage text", url: "https://example.com/a" });
    assert.equal(tavilyCalls[0].key, "Bearer fixture-quick");
    assert.deepEqual(tavilyCalls[0].body, { urls: ["https://example.com/a"], extract_depth: "basic", format: "markdown", timeout: 15 });

    tavilyCalls.length = 0;
    tavilyReply = () => Response.json({ results: [], failed_results: [{ url: "https://example.com/b", error: "blocked" }] });
    assert.equal(await tavilyExtract("https://example.com/b"), null);
    assert.equal(tavilyCalls.length, 1, "a page Tavily cannot read is not retried on the other pool");

    tavilyCalls.length = 0;
    tavilyReply = (call) => call.key === "Bearer fixture-quick" ? new Response("limit", { status: 432 }) : Response.json({ results: [{ raw_content: "Deep pool text" }] });
    assert.deepEqual(await tavilyExtract("https://example.com/c"), { text: "Deep pool text", url: undefined });
    assert.deepEqual(tavilyCalls.map(call => call.key), ["Bearer fixture-quick", "Bearer fixture-deep"]);
    tavilyCalls.length = 0;
    await tavilyExtract("https://example.com/d");
    assert.deepEqual(tavilyCalls.map(call => call.key), ["Bearer fixture-deep"], "the quick pool stays parked after 432");

    tavilyCalls.length = 0;
    tavilyReply = () => new Response("bad", { status: 500 });
    assert.equal(await tavilyExtract("https://example.com/e"), null);
    assert.equal(tavilyCalls.length, 1);
});

await check("the extractor falls back to Tavily only when the box could not read the page", async () => {
    const now = () => new Date("2026-11-19T00:00:00.000Z");
    const link = { kind: "link" as const, title: "Fixture", text: "", url: "https://example.com/post" };
    const reads: string[] = [];
    const tavily = async (url: string) => { reads.push(url); return { text: `# Heading\n\n![Logo](/static/logo.svg) [Next](/wiki/Next) [Note](#cite-1) ![](//cdn.example.org/a.png)\n\n${body(120)}`, url }; };
    const failing = (error: Error) => async () => { throw error; };

    const blocked = await extractCapture(link, { now, tavily, fetch: failing(new SourceFetchError("http", "The site answered HTTP 403.", 403)) });
    assert.equal(blocked.method, "tavily"); assert.equal(blocked.status, "ok"); assert.equal(blocked.note, "Read through Tavily because the site blocked the box.");
    assert.equal(blocked.finalUrl, link.url); assert.ok(blocked.words >= 120);
    assert.match(blocked.text, /\[Image: Logo\]\(https:\/\/example\.com\/static\/logo\.svg\) \[Next\]\(https:\/\/example\.com\/wiki\/Next\) \[Note\]\(#cite-1\) \[Image: untitled\]\(https:\/\/cdn\.example\.org\/a\.png\)/);
    assert.equal((await extractCapture(link, { now, tavily, fetch: failing(new SourceFetchError("timeout", "The site took too long to respond.")) })).note,
        "Read through Tavily because the site did not respond.");
    assert.equal((await extractCapture(link, { now, tavily, fetch: failing(new SourceFetchError("network", "The site could not be reached.")) })).note,
        "Read through Tavily because the site could not be reached.");
    assert.equal(reads.length, 3);

    reads.length = 0;
    for (const error of [new SourceFetchError("blocked", "This address isn't public, so Capture won't fetch it."), new SourceFetchError("dns", "The site's host name could not be found."),
        new SourceFetchError("http", "The site answered HTTP 404.", 404), new SourceFetchError("size", "The source is larger than 5 MB."), new SourceFetchError("type", "Capture reads web pages, text and PDFs, not image/png.")]) {
        const result = await extractCapture(link, { now, tavily, fetch: failing(error) });
        assert.equal(result.method, "html"); assert.equal(result.note, error.message);
    }
    assert.equal(reads.length, 0, "guard refusals, unknown hosts and other failures never reach Tavily");

    const page = (html: string) => async () => ({ kind: "html" as const, status: 200, finalUrl: link.url, contentType: "text/html", charset: "utf-8", body: Buffer.from(html) });
    const thin = await extractCapture(link, { now, tavily, fetch: page("<html><head><title>Thin</title></head><body><main><p>Only a few words here.</p></main></body></html>") });
    assert.equal(thin.method, "tavily"); assert.equal(thin.note, "Read through Tavily because the page had too little text.");
    const thinner = await extractCapture(link, { now, tavily: async () => ({ text: "Two words" }), fetch: page("<html><body><main><p>Only a few words here, more than two.</p></main></body></html>") });
    assert.equal(thinner.method, "html", "a fallback with fewer words is ignored");
    reads.length = 0;
    const full = await extractCapture(link, { now, tavily, fetch: page(`<html><body><main><article><p>${body(200)}</p></article></main></body></html>`) });
    assert.equal(full.method, "html"); assert.equal(reads.length, 0);

    const pdf = await extractCapture(link, { now, tavily, fetch: async () => ({ kind: "pdf" as const, status: 200, finalUrl: link.url, contentType: "application/pdf", body: Buffer.from("%PDF-1.4 broken") }) });
    assert.notEqual(pdf.method, "tavily"); assert.equal(reads.length, 0);

    const none = await extractCapture(link, { now, tavily: async () => null, fetch: failing(new SourceFetchError("http", "The site answered HTTP 403.", 403)) });
    assert.equal(none.status, "failed"); assert.equal(none.note, "The site answered HTTP 403.");

    process.env.CAPTURE_FETCH = "off";
    try { assert.equal((await extractCapture(link, { now, tavily })).status, "failed"); assert.equal(reads.length, 0); }
    finally { process.env.CAPTURE_FETCH = ""; }
});

await check("capture_add saves for the owner and links to the review", async () => {
    const saved: { profile: string; id: string; input: unknown }[] = [];
    const deps = {
        profile: async () => ({ id: "owner-profile" }),
        capture: async (profile: string, id: string, input: unknown) => {
            const source = validateCaptureSource(input);
            saved.push({ profile, id, input: source });
            return { id, profileId: profile, source, sourceHash: "0".repeat(64), createdAt: "2026-11-19T00:00:00.000Z", receipt: null };
        },
    };
    const result = await executeCaptureAdd({ kind: "link", title: "Attention", url: "https://arxiv.org/abs/1706.03762", text: "For the reading group" }, { userProfileId: "owner-profile" }, deps);
    const match = result.match(/^Saved to your Capture inbox for review: https:\/\/assistant\.test\/capture\?review=([0-9a-f-]{36})$/);
    assert.ok(match, result);
    assert.equal(saved[0].id, match[1]); assert.equal(saved[0].profile, "owner-profile");
    assert.deepEqual(saved[0].input, { kind: "link", title: "Attention", text: "For the reading group", url: "https://arxiv.org/abs/1706.03762" });
    assert.ok(confirmedActionReceipt("capture_add", {}, result));

    assert.match(await executeCaptureAdd({ kind: "text", title: "Quote", text: "A passage" }, {}, deps), /^Saved to your Capture inbox/);
    assert.equal(saved.length, 2);
    assert.equal(await executeCaptureAdd({ kind: "link", title: "x", url: "https://example.com" }, { userProfileId: "someone-else" }, deps),
        "Only the owner's conversations can save to the Capture inbox. Nothing was saved.");
    assert.equal(await executeCaptureAdd({ kind: "pdf", title: "x" }, {}, deps), "capture_add needs kind 'link' or 'text'. Nothing was saved.");
    assert.equal(await executeCaptureAdd({ kind: "text", title: "x", text: " " }, {}, deps), "A text capture needs the passage in text. Nothing was saved.");
    assert.equal(await executeCaptureAdd({ kind: "link", title: "x", url: "ftp://example.com" }, {}, deps), "Use an HTTP or HTTPS source URL without credentials. Nothing was saved.");
    assert.equal(await executeCaptureAdd({ kind: "link", title: "", url: "https://example.com" }, {}, deps), "The title must be 1 to 200 characters. Nothing was saved.");
    assert.equal(await executeCaptureAdd({ kind: "link", title: "x", url: "https://example.com" }, {}, { ...deps, profile: async () => { throw new CaptureError("Your profile is unavailable."); } }),
        "Your profile is unavailable. Nothing was saved.");
    assert.equal(saved.length, 2);
});

await check("capture_add needs approval when unattended, runs under Free only, and is not read-only", () => {
    assert.equal(unattendedDisposition("capture_add", {}), "approval");
    assert.equal(freeToolRefusal("capture_add", true), null);
    assert.equal(READ_ONLY_TOOLS.has("capture_add"), false);
    const tool = MCP_TOOLS.find(entry => entry.name === "capture_add");
    assert.ok(tool);
    assert.deepEqual(Object.entries(tool.parameters).filter(([, value]) => value.required).map(([name]) => name), ["kind", "title"]);
});

console.log(`\n${passed} capture extras checks passed.`);
