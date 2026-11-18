// Drafts one model profile with the live free sources and drafting chain, and prints it. Writes nothing unless --save is passed.
// Usage: npx tsx scripts/model-lookup.mts <providerId> <modelId> [--save]
import fs from "node:fs";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
const { getProvider } = await import("../src/lib/ai/providers");
const { readCatalogueRows } = await import("../src/lib/ai/catalogue/store");
const { gatherSources, lookupModel } = await import("../src/lib/ai/models/lookup");
const { liveLookupDeps, lookupTarget } = await import("../src/lib/ai/models/lookup-live");
const { collectModelObservations } = await import("../src/lib/ai/model-observations");
const { refreshStatsSnapshot } = await import("../src/lib/ai/models/stats");

const args = process.argv.slice(2);
const [providerId, modelId] = args.filter((arg) => !arg.startsWith("--"));
if (!providerId || !modelId) {
    console.log("Usage: npx tsx scripts/model-lookup.mts <providerId> <modelId> [--save]");
    process.exit(1);
}
const provider = getProvider(providerId);
if (!provider) throw new Error(`Unknown provider ${providerId}.`);
const stored = await readCatalogueRows();
if (!stored.ok) throw new Error(`The model catalogue is ${stored.reason}.`);
const row = stored.rows.find((entry) => entry.providerId === providerId && entry.modelId === modelId);
if (!row) throw new Error(`${providerId} ${modelId} is not in the catalogue.`);
await refreshStatsSnapshot();

const target = lookupTarget(provider, row);
const deps = liveLookupDeps();
const started = Date.now();
const { sources, tried } = await gatherSources(target, deps);
console.log(`Sources in ${Date.now() - started} ms: ${tried.map((entry) => `${entry.name} ${entry.ok ? "ok" : "none"}`).join(", ")}`);
for (const [index, source] of sources.entries()) console.log(`  [${index + 1}] ${source.title}${source.url ? ` ${source.url}` : ""} (${source.text.length} chars)`);
console.log(`Measurements:\n${target.measurements.map((line) => `  ${line}`).join("\n") || "  none"}`);

// A second gather inside lookupModel keeps this script on the real code path; the OpenRouter list is cached for an hour.
const { value: outcome, observations } = await collectModelObservations(() => lookupModel(target, deps), ["public_search"]);
for (const call of observations) {
    console.log(`Model call: ${call.providerId} ${call.modelId} ${call.status}${call.httpStatus ? ` HTTP ${call.httpStatus}` : ""} in ${Math.round(call.durationMs)} ms, output ${call.usage?.outputTokens ?? "?"} tokens`);
}
if (!outcome.ok) {
    console.log(`Draft failed: ${outcome.error}`);
} else {
    console.log(JSON.stringify(outcome.draft, null, 2));
}
console.log(`Total ${Date.now() - started} ms.`);

if (args.includes("--save")) {
    const { saveDrafts, readProfile } = await import("../src/lib/ai/models/store");
    const previous = await readProfile(providerId, modelId).catch(() => null);
    const attempts = outcome.ok ? 0 : (previous?.draftStatus === "failed" ? previous.lookupAttempts : 0) + 1;
    await saveDrafts([{ providerId, modelId, attempts, outcome }]);
    console.log("Saved the draft for review.");
}
