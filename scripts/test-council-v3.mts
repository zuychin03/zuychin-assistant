import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COUNCIL_HOST_GENERATION, configuredCapabilities } from "../src/lib/council/v3.ts";

// An online seat is a managed API call: it declares model selection and nothing
// that would let a model act on the box.
const seat = configuredCapabilities({ kind: "managed_api", modelSelection: true, observedAt: "2026-11-21T00:00:00.000Z" });
assert.deepEqual(seat, {
    kind: "managed_api", source: "configured", streaming: false, cancellation: false, sessionResume: false,
    modelSelection: true, structuredActions: true, toolCalls: false, permissionCallbacks: false,
    filesystemMediated: false, terminalMediated: false, observedAt: "2026-11-21T00:00:00.000Z",
});
assert.equal(COUNCIL_HOST_GENERATION, "typescript-node");

// supabase-setup.sql is the authoritative schema and is tracked; the
// supabase/migrations/ copy is gitignored, so reading it fails on a fresh clone.
const schema = readFileSync(join(process.cwd(), "supabase-setup.sql"), "utf8");
for (const required of [
    "claim_council_host_lease", "renew_council_host_lease", "release_council_host_lease",
    "issue_council_bound_host_seat_key", "start_council_bound_agent_execution", "start_council_versioned_bound_execution",
    "stop_council_agent_execution", "append_council_message_attributed", "propose_council_verdict", "accept_council_verdict",
    "pause_council", "resume_council", "continue_council",
    "resolve_agent_client_key", "exchange_agent_claim", "begin_agent_claim_attempt",
]) assert.ok(schema.includes(required), `supabase-setup.sql misses ${required}`);

console.log("Council V3 online seat capabilities and schema functions passed.");
