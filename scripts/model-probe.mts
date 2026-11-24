// Probes one model with its dashboard key (when PROVIDER_KEYS_SECRET is set) or the key in .env.local, and prints the result. Never prints the key; stores nothing.
// Usage: npx tsx scripts/model-probe.mts <providerId> <modelId> [--kind chat|embedding|speech|transcription|rerank|parse|image|decision|live|translate] [--voice <id>] [--space <providerId>::<modelId>] [--no-vision] [--allow-paid]
import fs from "node:fs";
import { getProvider, getProviderApiKey } from "../src/lib/ai/providers";
import { collectModelObservations } from "../src/lib/ai/model-observations";
import { probeModel } from "../src/lib/ai/catalogue/probe";
import { probeEmbedding } from "../src/lib/ai/catalogue/probe-embedding";
import { probeTypedModel } from "../src/lib/ai/catalogue/probe-typed";
import { NON_CHAT_KINDS, type NonChatKind } from "../src/lib/ai/catalogue/sources";
import { refreshProviderKeys } from "../src/lib/ai/provider-keys/snapshot";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
if (process.env.PROVIDER_KEYS_SECRET) await refreshProviderKeys();
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const valued = new Set(["--kind", "--voice", "--space"].flatMap((name) => { const index = args.indexOf(name); return index >= 0 ? [index, index + 1] : []; }));
const [providerId, modelId] = args.filter((arg, index) => !arg.startsWith("--") && !valued.has(index));
const kind = option("--kind") ?? "chat";
if (!providerId || !modelId || (kind !== "chat" && !NON_CHAT_KINDS.includes(kind as NonChatKind))) {
    console.error("Usage: npx tsx scripts/model-probe.mts <providerId> <modelId> [--kind chat|embedding|speech|transcription|rerank|parse|image|decision|live|translate] [--voice <id>] [--space <providerId>::<modelId>] [--no-vision] [--allow-paid]");
    process.exit(2);
}
const provider = getProvider(providerId);
if (!provider) { console.error(`Unknown provider: ${providerId}`); process.exit(2); }
if (provider.unavailableReason) { console.error(`${provider.label} is unavailable: ${provider.unavailableReason}`); process.exit(2); }
const apiKey = getProviderApiKey(provider);
if (!apiKey) { console.error(`${provider.label} has no key on the dashboard or in .env.local.`); process.exit(2); }

const known = [...provider.chatModels, ...provider.embeddingModels].find((model) => model.id === modelId);
const paid = provider.discovery?.pricing === "all-paid" || known?.free === false || provider.metered === true;
if (paid && !args.includes("--allow-paid")) {
    console.error(`${provider.label} ${modelId} is a paid route. Pass --allow-paid to probe it.`);
    process.exit(2);
}

// --space probes the reference route first, so the same-space step has vectors to compare against.
async function reference() {
    const space = option("--space");
    if (!space || kind !== "embedding") return undefined;
    const [refProviderId, refModelId] = space.split("::");
    const refProvider = getProvider(refProviderId);
    const refKey = refProvider ? getProviderApiKey(refProvider) : undefined;
    if (!refProvider || !refKey || !refModelId) { console.error(`Unknown or keyless reference route: ${space}`); process.exit(2); }
    const result = await probeEmbedding({ provider: refProvider, modelId: refModelId, apiKey: refKey });
    if (!result.vectors) { console.error(`The reference route did not pass: ${result.status}`); process.exit(1); }
    return { partitionId: refModelId, ...result.vectors };
}

const { value: result, observations } = await collectModelObservations(async () => kind === "chat"
    ? probeModel({ provider, modelId, apiKey, checkVision: !args.includes("--no-vision") })
    : probeTypedModel({ kind: kind as NonChatKind, provider, modelId, apiKey, voice: option("--voice"), reference: await reference() }));
console.log(JSON.stringify({ providerId, modelId, kind, ...result }, null, 2));
console.log(`observations: ${observations.map((entry) => `${entry.purpose}/${entry.status}${entry.httpStatus ? `/${entry.httpStatus}` : ""}`).join(", ")}`);
