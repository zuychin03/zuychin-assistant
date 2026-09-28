import assert from "node:assert/strict";
import type { Content, GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import { generateGeminiChat } from "../src/lib/ai/gemini-chat";

let checks = 0;
const frame = (parts: Part[], finishReason?: string, extra = {}) => ({
    candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), ...extra }],
}) as GenerateContentResponse;
function fixture(turns: GenerateContentResponse[][], onRequest?: (index: number) => void) {
    const requests: GenerateContentParameters[] = [];
    const tokens: { text: string; reset?: boolean }[] = [];
    const tools: string[] = [];
    const client = { models: { async generateContentStream(params: GenerateContentParameters) {
        requests.push(structuredClone({ ...params, config: { ...params.config, abortSignal: undefined } }));
        onRequest?.(requests.length);
        assert.ok(turns.length, "Unexpected extra generation");
        const chunks = turns.shift()!;
        return (async function* () { for (const chunk of chunks) yield chunk; })();
    } } };
    return { requests, tokens, tools, run: (extra: Partial<Parameters<typeof generateGeminiChat>[0]> = {}) => generateGeminiChat({
        client, model: "fixture-model", contents: [{ role: "user", parts: [{ text: "Question" }] }],
        initialConfig: { tools: [{ functionDeclarations: [{ name: "read" }] }] }, finalConfig: {},
        executeTool: async (name) => { tools.push(name); return "result"; },
        onToken: (text, reset) => tokens.push({ text, reset }), ...extra,
    }) };
}
async function check(name: string, fn: () => Promise<void>) { await fn(); checks++; console.log("PASS " + name); }

await check("ordinary reply streams once", async () => {
    const f = fixture([[frame([{ text: "Hello " }]), frame([{ text: "world" }], "STOP")]]);
    assert.equal(await f.run(), "Hello world");
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.tokens.map((t) => t.text), ["Hello ", "world"]);
});
await check("tool response preserves signatures and IDs and streams final answer", async () => {
    const signed: Part = { functionCall: { id: "call-1", name: "read", args: { id: "doc" } }, thoughtSignature: "signature" };
    const f = fixture([[frame([{ text: "Thinking", thought: true }, signed], "STOP")],
        [frame([{ text: "Found " }]), frame([{ text: "evidence" }], "STOP")]]);
    assert.equal(await f.run(), "Found evidence");
    const contents = f.requests[1].contents as Content[];
    assert.deepEqual(contents[1].parts, [{ text: "Thinking", thought: true }, signed]);
    assert.equal(contents[2].parts?.[0].functionResponse?.id, "call-1");
    assert.deepEqual(f.tools, ["read"]);
    assert.deepEqual(f.tokens.map((t) => t.text), ["Found ", "evidence"]);
});
await check("tool narration is replaced by final streamed answer", async () => {
    const f = fixture([[frame([{ text: "Checking" }, { functionCall: { name: "read" } }], "STOP")], [frame([{ text: "Done" }], "STOP")]]);
    assert.equal(await f.run(), "Done");
    assert.ok(f.tokens.some((t) => t.reset && t.text === ""));
});
await check("native grounding stays one request with trailing citation metadata", async () => {
    const f = fixture([[frame([{ text: "Source answer" }]), frame([], "STOP", { groundingMetadata: { webSearchQueries: ["fixture"] } })]]);
    assert.equal(await f.run({ initialConfig: { tools: [{ googleSearch: {} }] }, cite: (text, candidate) => {
        assert.deepEqual(candidate.groundingMetadata?.webSearchQueries, ["fixture"]);
        return text + " [1]";
    } }), "Source answer [1]");
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.tools, []);
});
await check("exhausted tool budget returns refusal to calls and streams a tool-free wrap", async () => {
    const call = frame([{ functionCall: { name: "read", id: "a" } }], "STOP");
    const f = fixture([[call], [call], [frame([{ text: "Stopped" }], "STOP")]]);
    assert.equal(await f.run({ maxToolRounds: 1 }), "Stopped");
    assert.equal(f.tools.length, 1);
    assert.equal(f.requests[2].config?.tools, undefined);
    assert.match(JSON.stringify(f.requests[2].contents), /budget/);
});
await check("truncated prose continues without tools and keeps prefix once", async () => {
    const f = fixture([[frame([{ text: "First part " }], "MAX_TOKENS")], [frame([{ text: "second part" }], "STOP")]]);
    assert.equal(await f.run(), "First part second part");
    assert.equal(f.requests[1].config?.tools, undefined);
    assert.ok(f.tokens.some((t) => t.reset && t.text === "First part second part"));
});
await check("stream without terminal marker refuses to execute a tool", async () => {
    const f = fixture([[frame([{ functionCall: { name: "read" } }])]]);
    await assert.rejects(f.run(), /interrupted/i);
    assert.equal(f.tools.length, 0);
});
await check("truncated function calls cannot execute", async () => {
    const f = fixture([[frame([{ functionCall: { name: "read" } }], "MAX_TOKENS")]]);
    await assert.rejects(f.run(), /incomplete/i);
    assert.equal(f.tools.length, 0);
});
await check("aborted completed stream cannot execute a tool", async () => {
    const abort = new AbortController();
    const f = fixture([[frame([{ functionCall: { name: "read" } }], "STOP")]], () => abort.abort());
    await assert.rejects(f.run({ signal: abort.signal }), { name: "AbortError" });
    assert.equal(f.tools.length, 0);
});
await check("cancellation between tools prevents later side effects", async () => {
    const abort = new AbortController();
    const f = fixture([[frame([{ functionCall: { name: "first" } }, { functionCall: { name: "second" } }], "STOP")]]);
    const executed: string[] = [];
    await assert.rejects(f.run({ signal: abort.signal, executeTool: async (name) => { executed.push(name); abort.abort(); return "ok"; } }), { name: "AbortError" });
    assert.deepEqual(executed, ["first"]);
});
await check("duplicate function IDs fail before any side effect", async () => {
    const f = fixture([[frame([{ functionCall: { name: "read", id: "same" } }, { functionCall: { name: "read", id: "same" } }], "STOP")]]);
    await assert.rejects(f.run(), /duplicate/i);
    assert.equal(f.tools.length, 0);
});
await check("malformed function response fails before any side effect", async () => {
    const f = fixture([[frame([{ functionCall: { name: "read" } }, { functionCall: { args: {} } }], "STOP")]]);
    await assert.rejects(f.run(), /invalid/i);
    assert.equal(f.tools.length, 0);
});
await check("safety finish reports a clear failure", async () => {
    const f = fixture([[frame([], "SAFETY")]]);
    await assert.rejects(f.run(), /SAFETY/);
    assert.equal(f.requests.length, 1);
});
await check("bounded continuations retain a visible limit notice", async () => {
    const f = fixture(Array.from({ length: 4 }, () => [frame([{ text: "More words " }], "MAX_TOKENS")]));
    assert.match(await f.run(), /Cut short by the provider/);
    assert.equal(f.requests.length, 4);
});
await check("empty continuation preserves the incomplete-answer notice", async () => {
    const f = fixture([[frame([{ text: "A partial answer" }], "MAX_TOKENS")], [frame([], "STOP")]]);
    assert.match(await f.run(), /Cut short by the provider/);
});
console.log(`Gemini streaming: ${checks} checks passed.`);
