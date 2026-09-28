import assert from "node:assert/strict";
import { collectModelObservations, configureModelDataPolicy } from "../src/lib/ai/model-observations";
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://vault-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon", SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    GEMINI_API_KEY: "fixture-gemini", NVIDIA_NIM_API_KEY: "fixture-nim", GITHUB_VAULT_TOKEN: "fixture-vault", GITHUB_VAULT_REPO: "fixture/vault" });
let scenario: "ingest" | "lint" = "ingest", generationCalls = 0;
globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined, url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    if (url.hostname === "generativelanguage.googleapis.com") {
        generationCalls++;
        const text = scenario === "ingest" && generationCalls === 1
            ? JSON.stringify({ markdown: "---\ntitle: Fixture\ncategory: sources\n---\n# Fixture\n\nPrivate source.", summary: "Fixture summary", links: [] })
            : scenario === "lint" && generationCalls === 1 ? '{"findings":[]}' : '{"pass":false,"reason":"Offline verification stops before commit"}';
        return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
    }
    if (url.hostname === "integrate.api.nvidia.com") return Response.json({ data: [{ embedding: Array(2048).fill(0.1) }], usage: { prompt_tokens: 3, total_tokens: 3 } });
    if (url.hostname === "vault-fixture.supabase.co") {
        assert.ok(method === "GET" || url.pathname.includes("/rpc/"), "No hosted table writes in this fixture");
        return Response.json([]);
    }
    assert.equal(url.hostname, "api.github.com"); assert.equal(method, "GET", "Verifier fixture must stop before any Git write");
    if (scenario === "ingest") return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/contents/wiki/sources")) return Response.json(["fixture", "second"].map(name => ({ path: `wiki/sources/${name}.md`, name: `${name}.md`, type: "file", sha: "a".repeat(40) })));
    if (/\/contents\/wiki\/[^/]+$/.test(url.pathname)) return Response.json([]);
    if (url.pathname.includes("/contents/wiki/sources/")) return Response.json({ type: "file", sha: "a".repeat(40), content: Buffer.from("---\ntitle: Fixture\ncategory: sources\n---\n# Fixture\n\nPrivate source [[wiki/sources/missing]].").toString("base64") });
    return new Response(null, { status: 404 });
};
const { resolveEmbedding } = await import("../src/lib/ai/providers");
const { ingestToVault } = await import("../src/lib/vault/ingest");
const { lintVault } = await import("../src/lib/vault/lint");
const authored = await collectModelObservations(async () => {
    configureModelDataPolicy(false);
    await assert.rejects(ingestToVault({ title: "Fixture", content: "Private source", embRef: resolveEmbedding() }), /Verification failed/);
}, ["personal", "knowledge"]);
assert.equal(authored.observations.filter(call => call.purpose === "extraction").length, 2);
assert.equal(authored.observations.filter(call => call.purpose === "embedding").length, 1);
assert.ok(authored.observations.every(call => call.dataClasses?.includes("knowledge")));
scenario = "lint"; generationCalls = 0;
const reviewed = await collectModelObservations(async () => {
    configureModelDataPolicy(false);
    return lintVault({ mode: "auto", embRef: resolveEmbedding() });
}, ["knowledge", "unattended"]);
assert.equal(reviewed.observations.length, 2);
assert.ok(reviewed.observations.every(call => call.providerId === "gemini" && call.purpose === "summary" && call.dataRoute?.rule === "scheduled_generation"));
assert.ok(reviewed.value.warnings.some(warning => warning.includes("verification failed")));
assert.doesNotMatch(JSON.stringify([...authored.observations, ...reviewed.observations]), /Private source|fixture-gemini|fixture-vault/);
console.log("Vault observations: actual author/verifier and lint reviewer/verifier adapters observed; no provider or Git writes escaped offline fixtures.");
