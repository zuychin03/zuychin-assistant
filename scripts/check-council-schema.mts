// Council schema-drift check. The council functions are `create or replace`, and
// earlier sections of supabase-setup.sql define the same names. Re-running an old
// section alone puts back a body that reads the dropped campaign tables, so lease
// renewal fails at run time and online councils stall without any other sign.
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
        protocol_version: 3,
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

    const renewed = await rpc("renew_council_host_lease", {
        p_session_id: sessionId, p_host_id: hostId, p_lease_epoch: Number(lease.leaseEpoch), p_duration_seconds: 120,
    }) as { ok?: boolean; __error?: string };
    assert("the lease holder can renew without the campaign tables", renewed?.ok === true, renewed);

    // Parameter names must match: PostgREST misses any function called with other names.
    const campaign = await rpc("create_council_campaign", {
        p_session_id: sessionId, p_created_by: "alpha", p_work_items: [],
    }) as { __error?: string };
    assert("the local-only campaign functions stay dropped",
        /could not find the function/i.test(campaign?.__error ?? ""), campaign);
}

async function cleanup(): Promise<void> {
    if (!sessionId) return;
    const { error } = await db.from("council_sessions").delete().eq("id", sessionId);
    if (error) console.warn(`cleanup failed for ${sessionId}: ${error.message}`);
}

async function main(): Promise<void> {
    console.log("council schema after the local council clean-up");
    try {
        await run();
    } catch (err) {
        drift.push(err instanceof Error ? err.message : String(err));
        console.error(`  ABORT ${drift[drift.length - 1]}`);
    } finally {
        await cleanup();
    }

    if (drift.length === 0) {
        console.log("\nthe council schema matches supabase-setup.sql");
        process.exit(0);
    }

    console.error(`\nSCHEMA DRIFT: ${drift.length} assertion(s) failed.`);
    console.error("An older council section of supabase-setup.sql was probably re-run on its own.");
    console.error("Fix: re-run scripts/migrations/v7-council-local-cleanup.sql in the Supabase SQL");
    console.error("editor, then run this check again.");
    process.exit(1);
}

await main();
