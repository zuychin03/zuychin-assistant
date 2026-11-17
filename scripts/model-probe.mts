// Probes one model with the key in .env.local and prints the result. Never prints the key; stores nothing.
// Usage: npx tsx scripts/model-probe.mts <providerId> <modelId> [--no-vision] [--allow-paid]
import fs from "node:fs";
import { getProvider, getProviderApiKey } from "../src/lib/ai/providers";
import { collectModelObservations } from "../src/lib/ai/model-observations";
import { probeModel } from "../src/lib/ai/catalogue/probe";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
const args = process.argv.slice(2);
const [providerId, modelId] = args.filter((arg) => !arg.startsWith("--"));
if (!providerId || !modelId) {
    console.error("Usage: npx tsx scripts/model-probe.mts <providerId> <modelId> [--no-vision] [--allow-paid]");
    process.exit(2);
}
const provider = getProvider(providerId);
if (!provider) { console.error(`Unknown provider: ${providerId}`); process.exit(2); }
if (provider.unavailableReason) { console.error(`${provider.label} is unavailable: ${provider.unavailableReason}`); process.exit(2); }
const apiKey = getProviderApiKey(provider);
if (!apiKey) { console.error(`${provider.label} has no key in .env.local.`); process.exit(2); }

const known = provider.chatModels.find((model) => model.id === modelId);
const paid = provider.discovery?.pricing === "all-paid" || known?.free === false || provider.metered === true;
if (paid && !args.includes("--allow-paid")) {
    console.error(`${provider.label} ${modelId} is a paid route. Pass --allow-paid to probe it.`);
    process.exit(2);
}

const { value: result, observations } = await collectModelObservations(() => probeModel({
    provider, modelId, apiKey, checkVision: !args.includes("--no-vision"),
}));
console.log(JSON.stringify({ providerId, modelId, ...result }, null, 2));
console.log(`observations: ${observations.map((entry) => `${entry.purpose}/${entry.status}${entry.httpStatus ? `/${entry.httpStatus}` : ""}`).join(", ")}`);
