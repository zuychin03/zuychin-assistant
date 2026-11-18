// Prints the model roster the agent sees, from the stored catalogue, profiles and recorded calls. Read-only; never prints a key.
// Usage: npx tsx scripts/model-roster.mts [purpose] [--free-only] [--paid] [--counts]
import fs from "node:fs";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
const { refreshCatalogueSnapshot } = await import("../src/lib/ai/catalogue/snapshot");
const { refreshStatsSnapshot } = await import("../src/lib/ai/models/stats");
const { currentRoster, formatRoster, formatRosterSummary } = await import("../src/lib/ai/models/roster");
const { isPurposeTag } = await import("../src/lib/ai/models/tags");

const args = process.argv.slice(2);
const purpose = args.find(isPurposeTag) ?? null;
const policy = { freeOnly: args.includes("--free-only"), paidOrchestrator: args.includes("--paid"), unattended: false };

const [catalogue, stats] = await Promise.all([refreshCatalogueSnapshot(), refreshStatsSnapshot()]);
console.log(`Catalogue: ${catalogue.storage} (${catalogue.rows.length} rows). Profiles: ${catalogue.profileStorage} (${catalogue.profiles.length}). Speed and feedback: ${stats.storage} (${stats.speed.size} models timed).`);

if (args.includes("--counts")) {
    const { supabaseAdmin } = await import("../src/lib/supabase");
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const { data, error } = await supabaseAdmin.from("model_call_observations").select("provider_id, model_id, purpose, status, first_answer_ms")
        .gte("started_at", since).not("purpose", "in", "(embedding,speech)").limit(5000);
    if (error) console.log(`Counting calls failed: ${error.message}`);
    else {
        const counts = new Map<string, { calls: number; timed: number }>();
        for (const row of data ?? []) {
            const key = `${row.provider_id}::${row.model_id}`;
            const entry = counts.get(key) ?? { calls: 0, timed: 0 };
            entry.calls++;
            if (row.status === "success" && row.first_answer_ms !== null) entry.timed++;
            counts.set(key, entry);
        }
        console.log(`\nCalls in the last 14 days (embedding and speech left out): ${data?.length ?? 0}`);
        for (const [key, entry] of [...counts].sort((a, b) => b[1].calls - a[1].calls)) console.log(`  ${key}: ${entry.calls} calls, ${entry.timed} timed successes`);
    }
}

const entries = currentRoster(policy);
console.log(`\n${formatRoster(entries, policy, purpose, { tools: false, vision: purpose === "vision" }, 40)}`);
console.log(`\n${formatRosterSummary(entries, policy) ?? "(no prompt roster)"}`);
