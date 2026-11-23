// Council V3 protocol tests. test-council-v3.mts covers the parts that run
// locally; this covers the plpgsql half the online runner uses: host leases,
// host-issued seat keys and execution records, plus a check that the local-only
// SQL (campaigns, work items, deliveries, owner notes) is gone.
//
//   npx tsx --env-file=.env.local scripts/test-council-v3-db.mts
//
// Requires the Council V3 wave of supabase-setup.sql to be applied. Every
// session it creates is prefixed CN-T and deleted afterwards, including on
// failure; the cascade takes the leases and executions with it.

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

    console.log("\nlease succession");
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

    console.log("\nlocal council clean-up");
    // v7-council-local-cleanup.sql drops what only the retired local host used. PostgREST matches a
    // function by its parameter names, so each call passes the real ones: only a dropped function misses.
    const dropped: Record<string, Record<string, unknown>> = {
        create_council_campaign: { p_session_id: id, p_created_by: "alpha", p_work_items: [] },
        claim_council_work_item: { p_session_id: id, p_agent_name: "alpha" },
        prepare_council_delivery: {
            p_session_id: id, p_agent_name: "alpha", p_host_id: hostId, p_lease_epoch: epoch,
            p_from_seq: 0, p_through_seq: 1, p_prompt_hash: "ph", p_prompt_body: "body",
        },
        add_council_owner_note: { p_session_id: id, p_agent_name: null, p_body: "x" },
        resolve_council_seat_key: { p_token_hash: "x" },
        conclude_council: { p_session_id: id, p_closer: "alpha", p_verdict: "v", p_open_questions: [] },
    };
    for (const [fn, args] of Object.entries(dropped)) {
        const result = await rpc(fn, args) as { __error?: string } | null;
        check(`${fn} is gone`, /could not find the function/i.test(result?.__error ?? ""), result);
    }
    for (const table of ["council_campaigns", "council_work_items", "council_verification_runs", "council_integration_attempts", "council_owner_notes", "council_deliveries"]) {
        const { error: tableError } = await db.from(table).select("*").limit(1);
        check(`${table} is gone`, !!tableError, tableError?.message ?? "still readable");
    }
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
        if (err instanceof Error && /council_host_leases|protocol_version/.test(err.message)) {
            console.error("This looks like the Council V3 wave has not been applied yet.");
        }
    } finally {
        await cleanup();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

await main();
