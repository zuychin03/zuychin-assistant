import { createHash } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { READ_ONLY_TOOLS } from "@/lib/ai/mcp-service";

// Durable intent for anything that changes state outside this process. The
// record is written BEFORE the call runs and keyed to the logical task rather
// than the attempt, so a resumed run recognises what already happened instead
// of being told in prose not to redo it.
//
// This does not make external effects exactly-once - nothing can. It gives
// durable intent, a stable key, and a refusal to blindly reissue a send whose
// outcome nobody knows.

export type ToolEffect = "read" | "write" | "external_send";

// Effects that leave the machine. A failure here is never assumed to have
// failed: the message may well have gone.
const EXTERNAL_SEND = new Set(["send_email", "draft_gmail_reply", "manage_calendar_event"]);

// In-process only - artifacts, planning, skills. Redoing one costs a little
// time and nothing else, so journalling them would only add write traffic.
const UNJOURNALLED = new Set([
    "update_plan", "run_subagents", "use_skill", "save_skill",
    "create_document", "create_code_file", "create_code_bundle",
]);

// A 'started' row this old belongs to a run that died mid-call.
const STALE_CLAIM_SECONDS = 600;

export function toolEffect(name: string): ToolEffect {
    if (READ_ONLY_TOOLS.has(name)) return "read";
    return EXTERNAL_SEND.has(name) ? "external_send" : "write";
}

export function isJournalled(name: string): boolean {
    return !UNJOURNALLED.has(name) && toolEffect(name) !== "read";
}

function argsHash(args: Record<string, unknown>): string {
    // Key order varies between model turns, so the hash is taken over sorted
    // entries: the same call must produce the same key on a resumption.
    const stable = JSON.stringify(args, Object.keys(args).sort());
    return createHash("sha256").update(stable).digest("hex");
}

function operationKey(rootRunId: string, tool: string, hash: string): string {
    return createHash("sha256").update(`${rootRunId}|${tool}|${hash}`).digest("hex");
}

interface ClaimResult {
    claimed: boolean;
    id?: string;
    status?: string;
    receipt?: { result?: string } | null;
    effect?: ToolEffect;
    age_seconds?: number;
}

/**
 * Runs a mutating tool at most once per logical task. Returns the recorded
 * result when the same call already succeeded, and refuses to reissue an
 * external send whose outcome was never established.
 */
export async function journalledCall(params: {
    rootRunId: string | null;
    runId: string | null;
    tool: string;
    args: Record<string, unknown>;
    run: () => Promise<string>;
}): Promise<string> {
    const { rootRunId, runId, tool, args } = params;
    // Without a run row there is nothing to key against; the journal is a
    // best-effort record, never a reason to refuse work.
    if (!rootRunId) return params.run();

    const effect = toolEffect(tool);
    const hash = argsHash(args);
    const key = operationKey(rootRunId, tool, hash);

    let claim: ClaimResult;
    try {
        const { data, error } = await supabase.rpc("claim_tool_call", {
            p_operation_key: key, p_run_id: runId, p_root_run_id: rootRunId,
            p_tool: tool, p_effect: effect, p_args_hash: hash,
        });
        if (error) throw new Error(error.message);
        claim = (data ?? { claimed: true }) as ClaimResult;
    } catch (err) {
        console.warn("[Journal] claim failed, running unjournalled:", err);
        return params.run();
    }

    if (!claim.claimed) {
        if (claim.status === "succeeded") {
            return claim.receipt?.result
                ?? `Already done earlier in this task; not repeated. (${tool})`;
        }
        if (claim.status === "outcome_unknown") {
            return `NOT REPEATED: an earlier attempt at ${tool} with these exact arguments was interrupted and it is unknown whether it took effect. Do not try again. Tell the user it needs checking by hand.`;
        }
        const stale = (claim.age_seconds ?? 0) > STALE_CLAIM_SECONDS;
        if (effect === "external_send") {
            // Never reissued on a timer. A second email is worse than none.
            return `NOT REPEATED: ${tool} with these exact arguments is already recorded for this task (${claim.status}). Do not try again; report it to the user instead.`;
        }
        if (!stale && claim.status === "started") {
            return `NOT REPEATED: ${tool} with these exact arguments is already in flight for this task.`;
        }
        // Our own storage, and provably dead or failed: safe to retake.
        const { data: retaken } = await supabase.rpc("retake_tool_call", {
            p_id: claim.id, p_run_id: runId,
        });
        if (retaken !== true) {
            return `NOT REPEATED: ${tool} with these exact arguments is already recorded for this task (${claim.status}).`;
        }
        claim = { claimed: true, id: claim.id };
    }

    const finish = async (status: "succeeded" | "failed" | "outcome_unknown", result?: string) => {
        try {
            await supabase.rpc("finish_tool_call", {
                p_id: claim.id, p_status: status,
                p_receipt: result === undefined ? null : { result: result.slice(0, 8000) },
            });
        } catch (err) {
            console.warn("[Journal] finish failed:", err);
        }
    };

    try {
        const result = await params.run();
        await finish("succeeded", result);
        return result;
    } catch (err) {
        // An external send that threw may still have gone out, so it is marked
        // uncertain rather than failed and is never retried automatically.
        await finish(effect === "external_send" ? "outcome_unknown" : "failed");
        throw err;
    }
}
