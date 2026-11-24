// Live check for the V8 memory gate: asks the decision model both gate questions for every fixture turn and shows
// whether the thresholds give the intended outcome. Writes nothing to the database.
// Usage: npx tsx --tsconfig tsconfig.json --env-file=.env.local scripts/memory-gate-calibrate.mts [--paid] [--write]
// The free key by default; --write stores the answers in the fixture that scripts/test-decisions.mts checks.
import fs from "node:fs";
import { getProvider, getProviderApiKey } from "../src/lib/ai/providers";
import { refreshProviderKeys } from "../src/lib/ai/provider-keys/snapshot";
import { decide } from "../src/lib/ai/decisions";
import { gateInput, gateVerdict, MEMORY_GATE_QUESTIONS, type GateTurn } from "../src/lib/ai/memory/gate";
import type { CatalogueRow } from "../src/lib/ai/catalogue/snapshot";

interface FixtureTurn extends GateTurn {
    id: string;
    expect: { extract: boolean; injected: boolean };
    answers?: { remember: number; injected: number };
}

const fixtureUrl = new URL("./fixtures/memory-gate-turns.json", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixtureUrl, "utf8")) as { recorded: unknown; turns: FixtureTurn[] };
if (process.env.PROVIDER_KEYS_SECRET) await refreshProviderKeys();
const providerId = process.argv.includes("--paid") ? "gemini" : "gemini-free";
const provider = getProvider(providerId);
const apiKey = provider && getProviderApiKey(provider);
if (!provider || !apiKey) throw new Error(`No key for ${providerId}.`);
const modelId = "gemini-decision-1";
const route = { provider, modelId, apiKey, row: { providerId, modelId, label: `Gemini Decision 1 on ${providerId}` } as CatalogueRow };

const round = (value: number | string) => Math.round(Number(value) * 1000) / 1000;
let misses = 0;
const times: number[] = [];
for (const turn of fixture.turns) {
    const decided = await decide(gateInput(turn), MEMORY_GATE_QUESTIONS, { freeOnly: providerId === "gemini-free", route, timeoutMs: 15_000 });
    if (!decided) {
        misses++;
        console.log(`${turn.id.padEnd(26)} no answer`);
        continue;
    }
    times.push(decided.ms);
    turn.answers = { remember: round(decided.answers.remember.value), injected: round(decided.answers.injected.value) };
    const verdict = gateVerdict(decided.answers);
    const ok = verdict.extract === turn.expect.extract && verdict.injected === turn.expect.injected;
    if (!ok) misses++;
    console.log(`${turn.id.padEnd(26)} remember ${turn.answers.remember.toFixed(3)}  injected ${turn.answers.injected.toFixed(3)}  ${verdict.extract ? "extract" : "skip   "}${verdict.injected ? " flagged" : "        "}  ${ok ? "as intended" : "NOT as intended"}  ${decided.ms} ms`);
}
times.sort((a, b) => a - b);
console.log(`\n${fixture.turns.length - misses} of ${fixture.turns.length} as intended; median ${times[Math.floor(times.length / 2)] ?? "-"} ms, slowest ${times.at(-1) ?? "-"} ms`);
if (process.argv.includes("--write")) {
    fixture.recorded = { model: modelId, key: providerId, date: new Date().toISOString().slice(0, 10) };
    fs.writeFileSync(fixtureUrl, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log("Answers written to the fixture.");
}
