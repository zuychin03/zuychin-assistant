// Council V3 schema-drift check. The V3 functions are `create or replace` and
// an earlier section of supabase-setup.sql defines the same names, so a partial
// re-run silently reverts acceptance to the V2 flag-based body. Nothing errors
// and nothing logs; the only symptom is the exact-commit gate being absent.
//
//   npx tsx --env-file=.env.local scripts/check-council-schema.mts
//
// This asserts behaviour, not the presence of tables. It creates one CN-D
// session and deletes it afterwards, including on failure.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
    process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const DIGEST = "d".repeat(64);

const drift: string[] = [];
let sessionId: string | null = null;

function assert(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        console.log(`  ok    ${name}`);
        return;
    }
    console.log(`  DRIFT ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    drift.push(name);
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown> | boolean | null> {
    const { data, error } = await db.rpc(fn, args);
    if (error) return { __error: error.message };
    return data as Record<string, unknown> | boolean | null;
}

async function run(): Promise<void> {
    const hostId = randomUUID();

    const { data: session, error } = await db.from("council_sessions").insert({
        code: `CN-D${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        topic: "schema drift check",
        brief: "schema drift check",
        closer_name: "alpha",
        max_messages: 60,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        repo_path: "/tmp/repo",
        base_branch: "main",
        protocol_version: 3,
        base_sha: BASE_SHA,
    }).select("id").single();
    if (error) throw new Error(`session insert failed: ${error.message}`);
    sessionId = session.id as string;

    const { error: rosterError } = await db.from("council_participants").insert({
        session_id: sessionId, name: "alpha", kind: "agent", expertise: "test",
        joined_seq: 1, dispatch_mode: true,
    });
    if (rosterError) throw new Error(`roster insert failed: ${rosterError.message}`);

    const lease = await rpc("claim_council_host_lease", {
        p_session_id: sessionId, p_host_id: hostId, p_duration_seconds: 120,
    }) as { ok?: boolean; leaseEpoch?: number };
    if (lease?.ok !== true) throw new Error(`could not claim a host lease: ${JSON.stringify(lease)}`);
    const epoch = Number(lease.leaseEpoch);

    await rpc("conclude_council", {
        p_session_id: sessionId, p_closer: "alpha", p_verdict: "v", p_open_questions: [],
    });
    const campaign = await rpc("create_council_campaign", {
        p_session_id: sessionId, p_created_by: "alpha",
        p_work_items: [{
            agent_name: "alpha", title: "t", instructions: "i",
            acceptance_criteria: [], declared_paths: ["src"],
        }],
    }) as { campaign_id?: string };
    if (!campaign?.campaign_id) throw new Error(`campaign creation failed: ${JSON.stringify(campaign)}`);

    const { data: campaignRow } = await db.from("council_campaigns")
        .select("base_sha").eq("id", campaign.campaign_id).single();
    assert("create_council_campaign freezes the session base sha",
        campaignRow?.base_sha === BASE_SHA, campaignRow);

    const item = await rpc("claim_council_work_item", {
        p_session_id: sessionId, p_agent_name: "alpha",
    }) as { id?: string };
    if (!item?.id) throw new Error(`work item claim failed: ${JSON.stringify(item)}`);
    await rpc("complete_council_work_item", {
        p_item_id: item.id, p_agent_name: "alpha",
        p_commit_hash: COMMIT_SHA, p_verification: "the agent's own claim",
    });

    const premature = await rpc("review_council_work_item", {
        p_item_id: item.id, p_reviewer: "alpha", p_accepted: true, p_note: "n",
    }) as { ok?: boolean; reason?: string };
    assert("review_council_work_item refuses acceptance without host evidence",
        premature?.ok === false && premature?.reason === "not_exactly_verified", premature);

    // The V2 trap: record_host_verification sets host_verified, which the V2
    // body treated as authorisation. Under V3 it must not unlock anything.
    const legacy = await rpc("record_host_verification", {
        p_item_id: item.id, p_passed: true, p_report: "legacy flag",
    }) as { __error?: string };
    // Only a missing-function error counts as dropped. Any other error would
    // mean the function is back with a different shape, which is drift.
    const legacyGone = /could not find the function/i.test(legacy?.__error ?? "");
    const afterLegacy = legacyGone ? null : await rpc("review_council_work_item", {
        p_item_id: item.id, p_reviewer: "alpha", p_accepted: true, p_note: "n",
    }) as { ok?: boolean; reason?: string };
    assert("record_host_verification cannot unlock acceptance",
        legacyGone || (afterLegacy?.ok === false && afterLegacy?.reason === "not_exactly_verified"),
        legacyGone ? "function dropped" : afterLegacy);

    const evidence = await rpc("record_council_verification", {
        p_item_id: item.id, p_host_id: hostId, p_lease_epoch: epoch, p_commit_sha: COMMIT_SHA,
        p_base_sha: BASE_SHA, p_branch_name: "council/d/alpha", p_profile_id: "standard",
        p_command_receipts: [{ command: ["true"], exitCode: 0 }],
        p_output_digest: DIGEST, p_passed: true, p_report: "all checks pass",
    }) as { ok?: boolean };
    assert("the lease holder can record exact-commit evidence", evidence?.ok === true, evidence);

    const accepted = await rpc("review_council_work_item", {
        p_item_id: item.id, p_reviewer: "alpha", p_accepted: true, p_note: "good",
    }) as { ok?: boolean };
    assert("matching evidence unlocks acceptance", accepted?.ok === true, accepted);

    const { data: itemRow } = await db.from("council_work_items")
        .select("status, accepted_commit_sha").eq("id", item.id).single();
    assert("the accepted commit sha is pinned on the item",
        itemRow?.status === "verified" && itemRow?.accepted_commit_sha === COMMIT_SHA, itemRow);
}

async function cleanup(): Promise<void> {
    if (!sessionId) return;
    const { error } = await db.from("council_sessions").delete().eq("id", sessionId);
    if (error) console.warn(`cleanup failed for ${sessionId}: ${error.message}`);
}

async function main(): Promise<void> {
    console.log("council V3 exact-commit gate");
    try {
        await run();
    } catch (err) {
        drift.push(err instanceof Error ? err.message : String(err));
        console.error(`  ABORT ${drift[drift.length - 1]}`);
    } finally {
        await cleanup();
    }

    if (drift.length === 0) {
        console.log("\nthe exact-commit gate is enforced");
        process.exit(0);
    }

    console.error(`\nSCHEMA DRIFT: ${drift.length} assertion(s) failed.`);
    console.error("The live V3 functions do not match supabase-setup.sql. Acceptance may be");
    console.error("running the V2 flag-based body, which means the exact-commit gate is absent.");
    console.error("Fix: re-run the '-- ===== Council V3 wave =====' tail of supabase-setup.sql");
    console.error("in the Supabase SQL editor, then run this check again.");
    process.exit(1);
}

await main();
