// Lists each provider's models with its dashboard key (when PROVIDER_KEYS_SECRET is set) or the key in .env.local, and prints what a discovery run would do.
// Writes nothing and never prints a key. Usage: npx tsx scripts/model-discovery-dry-run.mts [providerId...]
import fs from "node:fs";
import { PROVIDERS, getProviderApiKey, retiredChatModelIds, withAccount } from "../src/lib/ai/providers";
import { NON_CHAT_KINDS, listProviderModels, selectDiscoverable, shortNameFor, uniqueShortName } from "../src/lib/ai/catalogue/sources";
import { refreshProviderKeys } from "../src/lib/ai/provider-keys/snapshot";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
if (process.env.PROVIDER_KEYS_SECRET) await refreshProviderKeys();
const MAX_PROBES = Number(process.env.MODEL_DISCOVERY_MAX_PROBES) || 10;
const only = new Set(process.argv.slice(2));

for (const provider of PROVIDERS.map(withAccount)) {
    if (only.size && !only.has(provider.id)) continue;
    const discovery = provider.discovery;
    if (!discovery) { console.log(`\n${provider.id}: discovery off${provider.unavailableReason ? " (provider unavailable)" : ""}`); continue; }
    if (provider.unavailableReason) { console.log(`\n${provider.id}: skipped, provider unavailable`); continue; }
    const key = getProviderApiKey(provider);
    if (!key) { console.log(`\n${provider.id}: skipped, no key`); continue; }

    if (discovery.source === "seeded") { console.log(`\n${provider.id}: seeded, no list to read; seed rows are retested every ${discovery.probeEveryDays ?? 7} days`); continue; }
    const started = Date.now();
    const listing = await listProviderModels(provider, discovery, key);
    if (!listing.ok) { console.log(`\n${provider.id}: listing failed (${listing.status ?? "no status"}): ${listing.error}`); continue; }
    const tracked = selectDiscoverable(listing.models, discovery, retiredChatModelIds(provider.id));
    const listedIds = new Set(listing.models.map((model) => model.modelId));
    const codeIds = new Set(provider.chatModels.map((model) => model.id));
    const fresh = tracked.filter((model) => !codeIds.has(model.modelId));
    const missing = provider.chatModels.filter((model) => !listedIds.has(model.id));
    const taken = new Set(provider.chatModels.map((model) => model.name));
    const named = fresh.map((model) => {
        const name = uniqueShortName(shortNameFor(model.modelId, discovery.nameSuffix), taken);
        taken.add(name);
        return { ...model, name };
    });
    const freeNew = named.filter((model) => model.free);
    const paidNew = named.filter((model) => !model.free);

    console.log(`\n${provider.id}: listed ${listing.models.length}, tracked ${tracked.length}, ${Date.now() - started} ms`);
    console.log(`  code models no longer listed (${missing.length}): ${missing.map((model) => model.id).join(", ") || "none"}`);
    console.log(`  new free models (${freeNew.length}), first ${Math.min(freeNew.length, MAX_PROBES, discovery.maxProbes ?? MAX_PROBES)} would be probed this run:`);
    for (const model of freeNew) console.log(`    ${model.modelId}  name=${model.name}  label="${model.label}"  tools=${model.listedTools ?? "?"} inputs=${model.inputs.join("+") || "?"} maxOut=${model.maxOutputTokens ?? "?"}`);
    if (paidNew.length) {
        console.log(`  new paid models (${paidNew.length}), listed as Untested, probed only on Test:`);
        for (const model of paidNew) console.log(`    ${model.modelId}  name=${model.name}  label="${model.label}"`);
    }
    for (const kind of NON_CHAT_KINDS) {
        const listed = listing.models.filter((model) => model.kind === kind);
        if (!listed.length) continue;
        const kept = selectDiscoverable(listing.models, discovery, new Set(), kind);
        console.log(`  ${kind}: listed ${listed.length}, tracked ${kept.length}${discovery.kinds?.[kind] ? "" : " (kind not configured)"}`);
        for (const model of kept) console.log(`    ${model.modelId}  ${model.free ? "free" : "paid"}${model.expiresAt ? `  expires ${model.expiresAt.slice(0, 10)}` : ""}${model.voices.length ? `  voices ${model.voices.length}` : ""}`);
    }
}
