// Council V3 protocol tests. test-council-v3.mts covers the parts that run
// locally (git, model selection, contracts); this covers the plpgsql half:
// host leases, durable delivery, execution evidence, the exact-commit gate,
// the accepted-sha manifest and integration reporting.
//
//   npx tsx --env-file=.env.local scripts/test-council-v3-db.mts
//
// Requires the Council V3 wave of supabase-setup.sql to be applied. Every
// session it creates is prefixed CN-T and deleted afterwards, including on
// failure; the cascade takes the leases, deliveries and executions with it.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
    process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

let passed = 0;
let failed = 0;
const created: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passed++;
        console.log(`  ok    ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    }
}

// Errors are returned rather than thrown so a wrong-arity call shows up as a
// single failed check instead of aborting the run.
async function rpc(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown> | boolean | null> {
    const { data, error } = await db.rpc(fn, args);
    if (error) return { __error: error.message };
    return data as Record<string, unknown> | boolean | null;
}

const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);
const DIGEST = "d".repeat(64);

async function run(): Promise<void> {
    const hostId = randomUUID();
    const otherHost = randomUUID();

    const { data: session, error } = await db.from("council_sessions").insert({
        code: `CN-T${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        topic: "v3 protocol test",
        brief: "v3 protocol test",
        closer_name: "alpha",
        max_messages: 60,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        repo_path: "/tmp/repo",
        base_branch: "main",
        protocol_version: 3,
        base_sha: BASE_SHA,
    }).select("id").single();
    if (error) throw new Error(`session insert failed: ${error.message}`);
    const id = session.id as string;
    created.push(id);

    // dispatch_mode marks a seat the host drives; prepare_council_delivery
    // refuses seats that long-poll for themselves.
    const { error: rosterError } = await db.from("council_participants").insert([
        { session_id: id, name: "alpha", kind: "agent", expertise: "test", joined_seq: 1, dispatch_mode: true },
        { session_id: id, name: "beta", kind: "agent", expertise: "test", joined_seq: 2, dispatch_mode: true },
    ]);
    if (rosterError) throw new Error(`roster insert failed: ${rosterError.message}`);

    console.log("\nhost lease");
    const lease = await rpc("claim_council_host_lease", {
        p_session_id: id, p_host_id: hostId, p_duration_seconds: 300,
    }) as { ok?: boolean; leaseEpoch?: number };
    check("a host can claim the lease", lease?.ok === true, lease);
    let epoch = Number(lease?.leaseEpoch);
    check("the lease carries an epoch", Number.isFinite(epoch) && epoch > 0, lease);

    const contended = await rpc("claim_council_host_lease", {
        p_session_id: id, p_host_id: otherHost, p_duration_seconds: 300,
    }) as { ok?: boolean };
    check("a second host cannot steal a live lease", contended?.ok === false, contended);

    const renewed = await rpc("renew_council_host_lease", {
        p_session_id: id, p_host_id: hostId, p_lease_epoch: epoch, p_duration_seconds: 300,
    }) as { ok?: boolean };
    check("the holder can renew", renewed?.ok === true, renewed);

    const staleRenew = await rpc("renew_council_host_lease", {
        p_session_id: id, p_host_id: hostId, p_lease_epoch: epoch - 1, p_duration_seconds: 300,
    }) as { ok?: boolean };
    check("a stale epoch cannot renew", staleRenew?.ok === false, staleRenew);

    console.log("\nhost-issued seat keys");
    const seat = await rpc("issue_council_host_seat_key", {
        p_session_id: id, p_seat_name: "beta", p_token_hash: `hash-${randomUUID()}`,
        p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        p_host_id: hostId, p_lease_epoch: epoch,
    }) as { ok?: boolean };
    check("the lease holder can issue a seat key", seat?.ok === true, seat);

    const staleSeat = await rpc("issue_council_host_seat_key", {
        p_session_id: id, p_seat_name: "beta", p_token_hash: `hash-${randomUUID()}`,
        p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        p_host_id: hostId, p_lease_epoch: epoch - 1,
    }) as { ok?: boolean };
    check("a fenced host cannot issue a seat key", staleSeat?.ok === false, staleSeat);

    console.log("\ndurable delivery");
    const prepared = await rpc("prepare_council_delivery", {
        p_session_id: id, p_agent_name: "alpha", p_host_id: hostId, p_lease_epoch: epoch,
        p_from_seq: 0, p_through_seq: 3, p_prompt_hash: "ph1", p_prompt_body: "body",
    }) as { delivery?: { id?: string } };
    const deliveryId = prepared?.delivery?.id;
    check("a delivery can be prepared", !!deliveryId, prepared);

    // The same turn must map to the same row, or a host restart mid-turn
    // duplicates the prompt instead of resuming it.
    const again = await rpc("prepare_council_delivery", {
        p_session_id: id, p_agent_name: "alpha", p_host_id: hostId, p_lease_epoch: epoch,
        p_from_seq: 0, p_through_seq: 3, p_prompt_hash: "ph1", p_prompt_body: "body",
    }) as { delivery?: { id?: string; redelivered?: boolean } };
    check("re-preparing the same turn returns the same delivery", again?.delivery?.id === deliveryId, again);

    const inFlight = await rpc("mark_council_delivery_in_flight", {
        p_delivery_id: deliveryId, p_host_id: hostId, p_lease_epoch: epoch,
    });
    check("the holder can mark it in flight", inFlight === true, inFlight);

    const foreign = await rpc("mark_council_delivery_in_flight", {
        p_delivery_id: deliveryId, p_host_id: otherHost, p_lease_epoch: epoch,
    });
    check("another host cannot drive that delivery", foreign === false, foreign);

    // A host that dies mid-turn is the case durable delivery exists for: the
    // successor must pick the turn up rather than lose or duplicate it.
    const released = await rpc("release_council_host_lease", {
        p_session_id: id, p_host_id: hostId, p_lease_epoch: epoch,
    });
    check("the holder can release the lease", released === true, released);

    const succession = await rpc("claim_council_host_lease", {
        p_session_id: id, p_host_id: otherHost, p_duration_seconds: 300,
    }) as { ok?: boolean; leaseEpoch?: number };
    const nextEpoch = Number(succession?.leaseEpoch);
    check("a successor claims a released lease at a higher epoch",
        succession?.ok === true && nextEpoch > epoch, succession);

    const takeover = await rpc("prepare_council_delivery", {
        p_session_id: id, p_agent_name: "alpha", p_host_id: otherHost, p_lease_epoch: nextEpoch,
        p_from_seq: 0, p_through_seq: 3, p_prompt_hash: "ph1", p_prompt_body: "body",
    }) as { delivery?: { id?: string; redelivered?: boolean; attempt?: number } };
    check("the successor inherits the in-flight turn as a redelivery",
        takeover?.delivery?.id === deliveryId && takeover?.delivery?.redelivered === true, takeover);
    check("the redelivery counts as a new attempt", (takeover?.delivery?.attempt ?? 0) > 1, takeover);

    const staleAck = await rpc("ack_council_delivery", {
        p_delivery_id: deliveryId, p_host_id: hostId, p_lease_epoch: epoch,
    }) as { ok?: boolean };
    check("the displaced host cannot acknowledge it", staleAck?.ok === false, staleAck);

    // A redelivery lands back in 'prepared', so the successor has to re-send
    // before it can acknowledge: an unsent turn is never acknowledgeable.
    const earlyAck = await rpc("ack_council_delivery", {
        p_delivery_id: deliveryId, p_host_id: otherHost, p_lease_epoch: nextEpoch,
    }) as { reason?: string };
    check("a turn that was never re-sent cannot be acknowledged", earlyAck?.reason === "not_in_flight", earlyAck);

    await rpc("mark_council_delivery_in_flight", {
        p_delivery_id: deliveryId, p_host_id: otherHost, p_lease_epoch: nextEpoch,
    });
    const acked = await rpc("ack_council_delivery", {
        p_delivery_id: deliveryId, p_host_id: otherHost, p_lease_epoch: nextEpoch,
    }) as { ok?: boolean };
    check("the successor can acknowledge the turn it re-sent", acked?.ok === true, acked);

    // Hand the lease back so the remaining sections run as the original host.
    await rpc("release_council_host_lease", {
        p_session_id: id, p_host_id: otherHost, p_lease_epoch: nextEpoch,
    });
    const reclaimed = await rpc("claim_council_host_lease", {
        p_session_id: id, p_host_id: hostId, p_duration_seconds: 300,
    }) as { leaseEpoch?: number };
    epoch = Number(reclaimed?.leaseEpoch);

    console.log("\nexecution evidence");
    const execution = await rpc("start_council_agent_execution", {
        p_session_id: id, p_agent_name: "alpha", p_host_id: hostId, p_lease_epoch: epoch,
        p_host_generation: "ts-node", p_connector_kind: "acp",
        p_connector_capabilities: { fs: true }, p_capability_source: "probed",
        p_identity_assurance: "host_bound", p_provider: "test", p_adapter_version: "1.0.0",
        p_requested_model: "opus", p_effective_model: "opus",
        p_requested_reasoning_effort: "high", p_effective_reasoning_effort: "high",
        p_model_source: "configured", p_branch_name: "council/x/alpha",
        p_worktree_path: "/tmp/wt", p_base_sha: BASE_SHA,
    }) as { executionId?: string };
    check("an execution records model and capability evidence", !!execution?.executionId, execution);

    const { data: execRow } = await db.from("council_agent_executions")
        .select("effective_model, capability_source, identity_assurance, base_sha")
        .eq("id", execution?.executionId).single();
    check("the evidence pins the effective model and base sha",
        execRow?.effective_model === "opus" && execRow?.base_sha === BASE_SHA, execRow);

    const stopped = await rpc("stop_council_agent_execution", {
        p_execution_id: execution?.executionId, p_host_id: hostId,
        p_lease_epoch: epoch, p_stop_reason: "done",
    });
    check("the holder can stop an execution", stopped === true, stopped);

    console.log("\nexact-commit gate");
    await rpc("conclude_council", { p_session_id: id, p_closer: "alpha", p_verdict: "v", p_open_questions: [] });
    const campaign = await rpc("create_council_campaign", {
        p_session_id: id, p_created_by: "alpha",
        p_work_items: [{
            agent_name: "alpha", title: "t", instructions: "i",
            acceptance_criteria: [], declared_paths: ["src"],
        }],
    }) as { campaign_id?: string };
    check("a V3 campaign is created", !!campaign?.campaign_id, campaign);

    const { data: campaignRow } = await db.from("council_campaigns")
        .select("base_sha, verification_profile").eq("id", campaign?.campaign_id).single();
    check("the campaign freezes the session base sha", campaignRow?.base_sha === BASE_SHA, campaignRow);

    const item = await rpc("claim_council_work_item", { p_session_id: id, p_agent_name: "alpha" }) as { id?: string };
    await rpc("complete_council_work_item", {
        p_item_id: item?.id, p_agent_name: "alpha",
        p_commit_hash: COMMIT_SHA, p_verification: "the agent's own claim",
    });

    const premature = await rpc("review_council_work_item", {
        p_item_id: item?.id, p_reviewer: "alpha", p_accepted: true, p_note: "n",
    }) as { reason?: string };
    check("acceptance without host evidence is refused", premature?.reason === "not_exactly_verified", premature);

    await rpc("record_council_verification", {
        p_item_id: item?.id, p_host_id: hostId, p_lease_epoch: epoch, p_commit_sha: OTHER_SHA,
        p_base_sha: BASE_SHA, p_branch_name: "council/x/alpha", p_profile_id: "standard",
        p_command_receipts: [], p_output_digest: DIGEST, p_passed: true, p_report: "wrong commit",
    });
    const mismatched = await rpc("review_council_work_item", {
        p_item_id: item?.id, p_reviewer: "alpha", p_accepted: true, p_note: "n",
    }) as { reason?: string };
    check("evidence for another commit does not unlock acceptance",
        mismatched?.reason === "not_exactly_verified", mismatched);

    const staleEvidence = await rpc("record_council_verification", {
        p_item_id: item?.id, p_host_id: hostId, p_lease_epoch: epoch - 1, p_commit_sha: COMMIT_SHA,
        p_base_sha: BASE_SHA, p_branch_name: "council/x/alpha", p_profile_id: "standard",
        p_command_receipts: [], p_output_digest: DIGEST, p_passed: true, p_report: "fenced",
    }) as { ok?: boolean };
    check("a fenced host cannot record evidence", staleEvidence?.ok === false, staleEvidence);

    const evidence = await rpc("record_council_verification", {
        p_item_id: item?.id, p_host_id: hostId, p_lease_epoch: epoch, p_commit_sha: COMMIT_SHA,
        p_base_sha: BASE_SHA, p_branch_name: "council/x/alpha", p_profile_id: "standard",
        p_command_receipts: [{ command: ["true"], exitCode: 0 }],
        p_output_digest: DIGEST, p_passed: true, p_report: "all checks pass",
    }) as { ok?: boolean };
    check("the lease holder can record exact-commit evidence", evidence?.ok === true, evidence);

    const accepted = await rpc("review_council_work_item", {
        p_item_id: item?.id, p_reviewer: "alpha", p_accepted: true, p_note: "good",
    }) as { ok?: boolean };
    check("acceptance succeeds on matching evidence", accepted?.ok === true, accepted);

    const { data: itemRow } = await db.from("council_work_items")
        .select("status, accepted_commit_sha").eq("id", item?.id).single();
    check("the accepted commit sha is pinned",
        itemRow?.status === "verified" && itemRow?.accepted_commit_sha === COMMIT_SHA, itemRow);

    console.log("\nmanifest and integration");
    const frozen = await rpc("freeze_council_integration_manifest", {
        p_session_id: id, p_host_id: hostId, p_lease_epoch: epoch,
    }) as { ok?: boolean };
    check("the accepted-sha manifest freezes", frozen?.ok === true, frozen);

    const refrozen = await rpc("freeze_council_integration_manifest", {
        p_session_id: id, p_host_id: hostId, p_lease_epoch: epoch,
    }) as { ok?: boolean };
    check("re-freezing is stable", refrozen?.ok === true, refrozen);

    const { data: manifestRow } = await db.from("council_campaigns")
        .select("integration_manifest, manifest_frozen_at").eq("id", campaign?.campaign_id).single();
    check("the manifest pins the accepted sha",
        JSON.stringify(manifestRow?.integration_manifest ?? "").includes(COMMIT_SHA)
        && !!manifestRow?.manifest_frozen_at, manifestRow);

    const integration = await rpc("record_council_integration_v3", {
        p_session_id: id, p_reporter: "alpha", p_host_id: hostId, p_lease_epoch: epoch,
        p_status: "verified", p_branch: "council/x/integration",
        p_tip_sha: OTHER_SHA, p_report: "merged clean",
    }) as { ok?: boolean };
    check("an integration result is recorded", integration?.ok === true, integration);

    const staleIntegration = await rpc("record_council_integration_v3", {
        p_session_id: id, p_reporter: "alpha", p_host_id: hostId, p_lease_epoch: epoch - 1,
        p_status: "verified", p_branch: "council/x/integration",
        p_tip_sha: OTHER_SHA, p_report: "fenced",
    }) as { ok?: boolean };
    check("a fenced host cannot record integration", staleIntegration?.ok === false, staleIntegration);

    const badStatus = await rpc("record_council_integration_v3", {
        p_session_id: id, p_reporter: "alpha", p_host_id: hostId, p_lease_epoch: epoch,
        p_status: "nonsense", p_branch: null, p_tip_sha: null, p_report: "x",
    }) as { ok?: boolean; __error?: string };
    check("an unknown integration status is refused", badStatus?.ok === false || !!badStatus?.__error, badStatus);
}

async function cleanup(): Promise<void> {
    if (created.length === 0) return;
    const { error } = await db.from("council_sessions").delete().in("id", created);
    if (error) console.warn(`cleanup failed for ${created.length} session(s): ${error.message}`);
    else console.log(`\ncleaned up ${created.length} test session(s)`);
}

async function main(): Promise<void> {
    try {
        await run();
    } catch (err) {
        failed++;
        console.error("\naborted:", err instanceof Error ? err.message : err);
        if (err instanceof Error && /council_host_leases|council_deliveries|protocol_version/.test(err.message)) {
            console.error("This looks like the Council V3 wave has not been applied yet.");
        }
    } finally {
        await cleanup();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

await main();
