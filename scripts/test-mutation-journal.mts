// Tests for the mutation journal: the thing that makes "do not redo completed
// work" enforceable rather than advisory.
//
//   npx tsx --env-file=.env.local scripts/test-mutation-journal.mts
//
// Requires the P7 migration. Every row it creates is deleted afterwards,
// including on failure.

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
const keys: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) { passed++; console.log(`  ok    ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`); }
}

interface Claim {
    claimed: boolean; id?: string; status?: string;
    receipt?: { result?: string } | null; effect?: string; age_seconds?: number;
}

async function claim(opKey: string, effect: string, tool = "send_email"): Promise<Claim> {
    keys.push(opKey);
    const { data, error } = await db.rpc("claim_tool_call", {
        p_operation_key: opKey, p_run_id: null, p_root_run_id: null,
        p_tool: tool, p_effect: effect, p_args_hash: "h",
    });
    if (error) throw new Error(`claim failed: ${error.message}`);
    return data as Claim;
}

async function main(): Promise<void> {
    try {
        console.log("\nclaiming");
        const k1 = `test-${randomUUID()}`;
        const first = await claim(k1, "external_send");
        check("a fresh call is claimed", first.claimed === true, first);

        const second = await claim(k1, "external_send");
        check("a second attempt is refused the claim", second.claimed === false, second);
        check("the refusal reports it is already started", second.status === "started", second);

        console.log("\nreplaying a completed call");
        await db.rpc("finish_tool_call", {
            p_id: first.id, p_status: "succeeded", p_receipt: { result: "Email sent to a@b.c" },
        });
        const replay = await claim(k1, "external_send");
        check("a succeeded call hands back its recorded result",
            replay.receipt?.result === "Email sent to a@b.c", replay);
        check("a succeeded call is not re-claimed", replay.claimed === false, replay);

        console.log("\nuncertain external sends");
        const k2 = `test-${randomUUID()}`;
        const sent = await claim(k2, "external_send");
        await db.rpc("finish_tool_call", { p_id: sent.id, p_status: "outcome_unknown", p_receipt: null });
        const after = await claim(k2, "external_send");
        check("an interrupted send stays uncertain", after.status === "outcome_unknown", after);

        // The rule that matters: an external send is never retaken, however old.
        await db.from("agent_tool_calls")
            .update({ created_at: new Date(Date.now() - 3600_000).toISOString() })
            .eq("operation_key", k2);
        const { data: retookSend } = await db.rpc("retake_tool_call", { p_id: sent.id, p_run_id: null });
        check("an external send is never retaken", retookSend !== true, retookSend);

        console.log("\nretaking a dead write");
        const k3 = `test-${randomUUID()}`;
        const write = await claim(k3, "write", "save_note");
        await db.rpc("finish_tool_call", { p_id: write.id, p_status: "failed", p_receipt: null });
        const { data: retookWrite } = await db.rpc("retake_tool_call", { p_id: write.id, p_run_id: null });
        check("a failed write can be retaken", retookWrite === true, retookWrite);

        const { data: row } = await db.from("agent_tool_calls").select("status").eq("operation_key", k3).single();
        check("retaking puts it back in flight", row?.status === "started", row);

        console.log("\nguards");
        const { data: badStatus } = await db.rpc("finish_tool_call", {
            p_id: write.id, p_status: "nonsense", p_receipt: null,
        });
        check("an unknown finish status is refused", badStatus === false, badStatus);
    } catch (err) {
        failed++;
        console.error("\naborted:", err instanceof Error ? err.message : err);
        if (err instanceof Error && /claim_tool_call|agent_tool_calls/.test(err.message)) {
            console.error("This looks like the P7 migration has not been applied yet.");
        }
    } finally {
        if (keys.length) {
            const { error } = await db.from("agent_tool_calls").delete().in("operation_key", keys);
            if (error) console.warn(`cleanup failed: ${error.message}`);
            else console.log(`\ncleaned up ${new Set(keys).size} journal row(s)`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

void main();
