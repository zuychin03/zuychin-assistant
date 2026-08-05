// Protocol tests for the council Postgres functions. The interesting logic
// lives in plpgsql, not TypeScript, so this exercises the functions directly
// rather than mocking a client.
//
//   npx tsx --env-file=.env.local scripts/test-council-protocol.mts
//
// Requires the P1 migration to be applied. Every session it creates is prefixed
// CN-T and deleted afterwards, including on failure; the cascade takes the
// participants, messages and campaigns with it.

import { createClient } from "@supabase/supabase-js";

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

function code(): string {
    return `CN-T${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function makeSession(opts: {
    agents: string[];
    maxMessages?: number;
    workspace?: boolean;
    closer?: string;
}): Promise<string> {
    const { data, error } = await db
        .from("council_sessions")
        .insert({
            code: code(),
            topic: "protocol test",
            brief: "protocol test",
            closer_name: opts.closer ?? opts.agents[0],
            max_messages: opts.maxMessages ?? 60,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            repo_path: opts.workspace ? "/tmp/repo" : null,
            base_branch: opts.workspace ? "main" : null,
        })
        .select("id")
        .single();
    if (error) throw new Error(`session insert failed: ${error.message}`);
    const id = data.id as string;
    created.push(id);
    const roster = opts.agents.map((name, i) => ({
        session_id: id, name, kind: "agent", expertise: "test", joined_seq: i + 1,
    }));
    const { error: rosterError } = await db.from("council_participants").insert(roster);
    if (rosterError) throw new Error(`roster insert failed: ${rosterError.message}`);
    return id;
}

// posts_per_round is deliberately huge in most tests: round advancement would
// otherwise reset counters mid-scenario and obscure what is being asserted.
async function post(sessionId: string, speaker: string, args: {
    intent: string; body: string; addressedTo?: string; replyToSeq?: number; postsPerRound?: number;
}): Promise<Record<string, unknown>> {
    const { data, error } = await db.rpc("append_council_message", {
        p_session_id: sessionId,
        p_speaker: speaker,
        p_role: "agent",
        p_intent: args.intent,
        p_body: args.body,
        p_client_key: `k${Math.random().toString(36).slice(2)}`,
        p_addressed_to: args.addressedTo ?? "all",
        p_reply_to_seq: args.replyToSeq ?? null,
        p_ack_seq: null,
        p_posts_per_round: args.postsPerRound ?? 99,
        p_stale_seconds: 180,
    });
    if (error) throw new Error(`append failed: ${error.message}`);
    return data as Record<string, unknown>;
}

async function testMessageCap(): Promise<void> {
    console.log("\nmessage cap");
    const id = await makeSession({ agents: ["alpha", "beta"], maxMessages: 3 });
    await post(id, "alpha", { intent: "propose", body: "one" });
    await post(id, "beta", { intent: "propose", body: "two" });
    const third = await post(id, "alpha", { intent: "refine", body: "three" });
    check("final permitted message is accepted", third.ok === true, third);

    const { data: session } = await db.from("council_sessions").select("status, last_seq").eq("id", id).single();
    check("cap flips the session to concluding", session?.status === "concluding", session);
    check("last_seq stops at the cap", session?.last_seq === 3, session);

    const fourth = await post(id, "beta", { intent: "refine", body: "four" });
    check("past the cap is refused", fourth.ok === false && fourth.reason === "message_cap", fourth);

    // conclude_council must still work on a capped session, or the debate is
    // unrecoverable rather than merely over.
    const { data: concluded } = await db.rpc("conclude_council", {
        p_session_id: id, p_closer: "alpha", p_verdict: "done", p_open_questions: [],
    });
    check("a capped council can still be concluded", (concluded as { changed?: boolean })?.changed === true, concluded);
}

async function testObligations(): Promise<void> {
    console.log("\nreply obligations");
    const id = await makeSession({ agents: ["alpha", "beta", "gamma"] });
    await post(id, "alpha", { intent: "propose", body: "a proposal" });
    const challenge = await post(id, "alpha", {
        intent: "challenge", body: "why?", addressedTo: "beta", replyToSeq: 1,
    });
    const obligationSeq = challenge.seq as number;

    const ghost = await post(id, "beta", { intent: "answer", body: "x", replyToSeq: 999 });
    check("citing a seq that does not exist is refused", ghost.reason === "no_such_seq", ghost);

    const notObligation = await post(id, "beta", { intent: "answer", body: "y", replyToSeq: 1 });
    check("answering a non-obligation is refused", notObligation.reason === "not_an_obligation", notObligation);

    const wrongAgent = await post(id, "gamma", {
        intent: "answer", body: "not mine to answer", replyToSeq: obligationSeq,
    });
    check("answering someone else's obligation is refused", wrongAgent.reason === "not_addressed_to_you", wrongAgent);

    const good = await post(id, "beta", { intent: "answer", body: "because", replyToSeq: obligationSeq });
    check("the addressed agent may answer", good.ok === true, good);
    check("the receipt reports the obligation cleared", good.cleared === true, good);

    const again = await post(id, "beta", { intent: "answer", body: "again", replyToSeq: obligationSeq });
    check("answering twice is refused", again.reason === "already_answered", again);
}

async function testWorkItemValidation(): Promise<void> {
    console.log("\nwork plan validation");
    const id = await makeSession({ agents: ["alpha", "beta"], workspace: true, closer: "alpha" });

    const valid = await db.rpc("validate_council_work_items", {
        p_session_id: id, p_created_by: "alpha",
        p_work_items: [{ agent_name: "alpha", title: "t", instructions: "i", acceptance_criteria: [] }],
    });
    check("a valid plan returns null", valid.data === null, valid.data);

    const offRoster = await db.rpc("validate_council_work_items", {
        p_session_id: id, p_created_by: "alpha",
        p_work_items: [{ agent_name: "nobody", title: "t", instructions: "i", acceptance_criteria: [] }],
    });
    check("an agent off the roster is rejected", typeof offRoster.data === "string", offRoster.data);

    const empty = await db.rpc("validate_council_work_items", {
        p_session_id: id, p_created_by: "alpha", p_work_items: [],
    });
    check("an empty plan is rejected", typeof empty.data === "string", empty.data);

    const wrongCloser = await db.rpc("validate_council_work_items", {
        p_session_id: id, p_created_by: "beta",
        p_work_items: [{ agent_name: "alpha", title: "t", instructions: "i", acceptance_criteria: [] }],
    });
    check("a non-closer is rejected", typeof wrongCloser.data === "string", wrongCloser.data);

    // The whole point of splitting validation out: it must be answerable while
    // the council is still open, before the verdict CAS.
    const { data: session } = await db.from("council_sessions").select("status").eq("id", id).single();
    check("validation works on an open council", session?.status === "open", session);
}

async function testWorkItemLease(): Promise<void> {
    console.log("\nwork item leases");
    const id = await makeSession({ agents: ["alpha"], workspace: true, closer: "alpha" });
    await db.rpc("conclude_council", {
        p_session_id: id, p_closer: "alpha", p_verdict: "v", p_open_questions: [],
    });
    const { error: campaignError } = await db.rpc("create_council_campaign", {
        p_session_id: id, p_created_by: "alpha",
        p_work_items: [{ agent_name: "alpha", title: "t", instructions: "i", acceptance_criteria: [] }],
    });
    if (campaignError) throw new Error(`campaign create failed: ${campaignError.message}`);

    const first = await db.rpc("claim_council_work_item", { p_session_id: id, p_agent_name: "alpha" });
    const claimed = first.data as { id: string; attempts: number; lease_expires_at: string } | null;
    check("claiming sets a lease", !!claimed?.lease_expires_at, claimed);
    check("claiming counts an attempt", claimed?.attempts === 1, claimed);

    await db.from("council_work_items")
        .update({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", claimed!.id);

    const second = await db.rpc("claim_council_work_item", { p_session_id: id, p_agent_name: "alpha" });
    const reclaimed = second.data as { attempts: number; status: string } | null;
    check("a lapsed lease is reclaimed", reclaimed?.status === "in_progress", reclaimed);
    check("the reclaim counts a second attempt", reclaimed?.attempts === 2, reclaimed);

    // Third expiry hits max_attempts (3) and must block rather than cycle.
    await db.from("council_work_items")
        .update({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", claimed!.id);
    await db.rpc("claim_council_work_item", { p_session_id: id, p_agent_name: "alpha" });
    await db.from("council_work_items")
        .update({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", claimed!.id);
    const fourth = await db.rpc("claim_council_work_item", { p_session_id: id, p_agent_name: "alpha" });
    const { data: item } = await db.from("council_work_items").select("status, attempts").eq("id", claimed!.id).single();
    check("attempts do not cycle forever", item?.status === "blocked", item);
    check("nothing is served once blocked", fourth.data === null, fourth.data);
}

async function testPause(): Promise<void> {
    console.log("\nstall and resume");
    const id = await makeSession({ agents: ["alpha", "beta"] });
    await post(id, "alpha", { intent: "propose", body: "before the pause" });

    const paused = await db.rpc("pause_council", { p_session_id: id });
    check("pausing a running council succeeds", (paused.data as { ok?: boolean })?.ok === true, paused.data);

    const blocked = await post(id, "beta", { intent: "propose", body: "during the pause" });
    check("agents cannot post while paused", blocked.reason === "paused", blocked);

    // The moderator is the channel the pause notice and the owner's relay both
    // travel on, so it must still get through.
    const { data: modPost } = await db.rpc("append_council_message", {
        p_session_id: id, p_speaker: "zuychin", p_role: "moderator", p_intent: "moderate",
        p_body: "stalled by your human", p_client_key: `m${Math.random()}`,
        p_addressed_to: "all", p_reply_to_seq: null, p_ack_seq: null,
        p_posts_per_round: 99, p_stale_seconds: 180,
    });
    check("the moderator can still speak while paused", (modPost as { ok?: boolean })?.ok === true, modPost);

    // A moderator post must not revoke a granted floor - the grant exists to
    // unstick a silent round, and a relay landing mid-grant would strand it.
    await db.from("council_sessions")
        .update({ floor_holder: "beta", floor_granted_at: new Date().toISOString() })
        .eq("id", id);
    await db.rpc("append_council_message", {
        p_session_id: id, p_speaker: "zuychin", p_role: "moderator", p_intent: "moderate",
        p_body: "a relay mid-grant", p_client_key: `m${Math.random()}`,
        p_addressed_to: "all", p_reply_to_seq: null, p_ack_seq: null,
        p_posts_per_round: 99, p_stale_seconds: 180,
    });
    const { data: heldFloor } = await db.from("council_sessions").select("floor_holder").eq("id", id).single();
    check("a moderator post preserves a granted floor", heldFloor?.floor_holder === "beta", heldFloor);

    // A paused council must not be swept away by the clock it is not running on.
    await db.from("council_sessions")
        .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", id);
    const { data: swept } = await db.from("council_sessions")
        .update({ status: "expired" })
        .eq("id", id)
        .in("status", ["open", "concluding"])
        .is("paused_at", null)
        .lt("expires_at", new Date().toISOString())
        .select("id");
    check("a paused council is not expired by the sweep", (swept ?? []).length === 0, swept);

    const resumed = await db.rpc("resume_council", { p_session_id: id });
    check("resuming succeeds", (resumed.data as { ok?: boolean })?.ok === true, resumed.data);

    const { data: after } = await db.from("council_sessions")
        .select("paused_at, expires_at, floor_holder").eq("id", id).single();
    check("resume clears the pause", after?.paused_at === null, after);
    check("resume gives back the time it took", Date.parse(after!.expires_at) > Date.now() - 60_000, after);
    check("resume drops the stale floor grant", after?.floor_holder === null, after);

    const allowed = await post(id, "beta", { intent: "propose", body: "after the resume" });
    check("agents can post again after resuming", allowed.ok === true, allowed);
}

async function testOwnerGate(): Promise<void> {
    console.log("\nowner-gated closure");
    const id = await makeSession({ agents: ["alpha", "beta"], workspace: true, closer: "alpha" });
    await post(id, "alpha", { intent: "propose", body: "a position" });

    const proposed = await db.rpc("propose_council_verdict", {
        p_session_id: id, p_closer: "alpha", p_verdict: "we should do X",
        p_open_questions: ["what about Y"],
        p_work_items: [{ agent_name: "alpha", title: "t", instructions: "i", acceptance_criteria: [] }],
        p_standby_seconds: 86400,
    });
    check("proposing a verdict succeeds", (proposed.data as { changed?: boolean })?.changed === true, proposed.data);

    const { data: standby } = await db.from("council_sessions")
        .select("status, verdict, standby_expires_at").eq("id", id).single();
    check("the council waits instead of closing", standby?.status === "awaiting_owner", standby);
    check("the verdict is recorded while it waits", standby?.verdict === "we should do X", standby);
    check("a standby deadline is set", !!standby?.standby_expires_at, standby);

    const blocked = await post(id, "beta", { intent: "propose", body: "one more thing" });
    check("agents cannot post while it waits", blocked.reason === "awaiting_owner", blocked);

    // Continue has to reach them somehow, so the moderator channel stays open.
    const { data: modPost } = await db.rpc("append_council_message", {
        p_session_id: id, p_speaker: "zuychin", p_role: "moderator", p_intent: "moderate",
        p_body: "waiting on the human", p_client_key: `m${Math.random()}`,
        p_addressed_to: "all", p_reply_to_seq: null, p_ack_seq: null,
        p_posts_per_round: 99, p_stale_seconds: 180,
    });
    check("the moderator can still speak while it waits", (modPost as { ok?: boolean })?.ok === true, modPost);

    const continued = await db.rpc("continue_council", { p_session_id: id, p_extra_rounds: 3 });
    check("sending it back reopens the council", (continued.data as { ok?: boolean })?.ok === true, continued.data);

    const { data: reopened } = await db.from("council_sessions")
        .select("status, verdict, max_rounds, continue_count, proposed_work_items").eq("id", id).single();
    check("reopening clears the rejected verdict", reopened?.verdict === null, reopened);
    check("reopening extends the round budget", reopened?.max_rounds === 9, reopened);
    check("reopening counts the round trip", reopened?.continue_count === 1, reopened);
    check("reopening drops the held work plan", reopened?.proposed_work_items === null, reopened);

    const allowed = await post(id, "beta", { intent: "propose", body: "back at it" });
    check("agents can post again after it reopens", allowed.ok === true, allowed);

    // Second pass: propose again, then accept.
    await db.rpc("propose_council_verdict", {
        p_session_id: id, p_closer: "alpha", p_verdict: "final answer",
        p_open_questions: [],
        p_work_items: [{ agent_name: "alpha", title: "t", instructions: "i", acceptance_criteria: [] }],
        p_standby_seconds: 86400,
    });
    const accepted = await db.rpc("accept_council_verdict", { p_session_id: id });
    const acc = accepted.data as { changed?: boolean; work_items?: unknown[] } | null;
    check("accepting closes the council", acc?.changed === true, acc);
    check("accepting hands back the held work plan", (acc?.work_items ?? []).length === 1, acc);

    const { data: closed } = await db.from("council_sessions").select("status").eq("id", id).single();
    check("the council ends up closed", closed?.status === "closed", closed);

    const again = await db.rpc("accept_council_verdict", { p_session_id: id });
    check("accepting twice changes nothing", (again.data as { changed?: boolean })?.changed === false, again.data);
}

async function testSeatKeys(): Promise<void> {
    console.log("\nguest seat keys");
    const { createHash, randomBytes } = await import("node:crypto");
    const hash = (t: string) => createHash("sha256").update(t).digest("hex");

    const id = await makeSession({ agents: ["alpha", "beta"] });
    const token = `zcs_${randomBytes(32).toString("hex")}`;

    const issued = await db.rpc("issue_council_seat_key", {
        p_session_id: id, p_seat_name: "alpha", p_token_hash: hash(token),
        p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    check("issuing for a roster seat succeeds", (issued.data as { ok?: boolean })?.ok === true, issued.data);

    const offRoster = await db.rpc("issue_council_seat_key", {
        p_session_id: id, p_seat_name: "nobody", p_token_hash: hash("x"),
        p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    check("issuing for a seat off the roster is refused", (offRoster.data as { ok?: boolean })?.ok === false, offRoster.data);

    const resolved = await db.rpc("resolve_council_seat_key", { p_token_hash: hash(token) });
    const seat = resolved.data as { session_id?: string; seat_name?: string } | null;
    check("a valid key resolves to its seat", seat?.seat_name === "alpha" && seat?.session_id === id, seat);

    const unknown = await db.rpc("resolve_council_seat_key", { p_token_hash: hash("not-a-key") });
    check("an unknown key resolves to nothing", unknown.data === null, unknown.data);

    const { data: claimed } = await db.from("council_seat_keys")
        .select("claimed_at").eq("session_id", id).eq("seat_name", "alpha").single();
    check("first use stamps the key as claimed", !!claimed?.claimed_at, claimed);

    // Re-issuing replaces the hash, which is how a mis-sent key is retired.
    const token2 = `zcs_${randomBytes(32).toString("hex")}`;
    await db.rpc("issue_council_seat_key", {
        p_session_id: id, p_seat_name: "alpha", p_token_hash: hash(token2),
        p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const stale = await db.rpc("resolve_council_seat_key", { p_token_hash: hash(token) });
    check("re-issuing invalidates the previous key", stale.data === null, stale.data);

    await db.from("council_seat_keys")
        .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("session_id", id).eq("seat_name", "alpha");
    const expired = await db.rpc("resolve_council_seat_key", { p_token_hash: hash(token2) });
    check("an expired key resolves to nothing", expired.data === null, expired.data);

    // A key must die with its council, not outlive it.
    const token3 = `zcs_${randomBytes(32).toString("hex")}`;
    await db.rpc("issue_council_seat_key", {
        p_session_id: id, p_seat_name: "beta", p_token_hash: hash(token3),
        p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    await db.from("council_sessions").update({ status: "closed" }).eq("id", id);
    const afterClose = await db.rpc("resolve_council_seat_key", { p_token_hash: hash(token3) });
    check("a key stops working once its council closes", afterClose.data === null, afterClose.data);
}

async function testHostVerification(): Promise<void> {
    console.log("\nhost-run verification");
    const id = await makeSession({ agents: ["alpha"], workspace: true, closer: "alpha" });
    await db.rpc("conclude_council", { p_session_id: id, p_closer: "alpha", p_verdict: "v", p_open_questions: [] });
    await db.rpc("create_council_campaign", {
        p_session_id: id, p_created_by: "alpha",
        p_work_items: [{ agent_name: "alpha", title: "t", instructions: "i", acceptance_criteria: [] }],
    });
    const claim = await db.rpc("claim_council_work_item", { p_session_id: id, p_agent_name: "alpha" });
    const item = claim.data as { id: string };
    await db.rpc("complete_council_work_item", {
        p_item_id: item.id, p_agent_name: "alpha",
        p_commit_hash: "deadbeef", p_verification: "I ran the tests and they passed",
    });

    // The whole point: the agent's own account is not enough to accept.
    const premature = await db.rpc("review_council_work_item", {
        p_item_id: item.id, p_reviewer: "alpha", p_accepted: true, p_note: "looks fine",
    });
    check("accepting before the host checks is refused",
        (premature.data as { reason?: string })?.reason === "not_host_verified", premature.data);

    const failed = await db.rpc("record_host_verification", {
        p_item_id: item.id, p_passed: false, p_report: "FAIL commit does not descend from main",
    });
    check("a failed host check is recorded", failed.data === true, failed.data);
    const { data: bounced } = await db.from("council_work_items").select("status, host_verified").eq("id", item.id).single();
    check("a failed host check returns the task to its owner", bounced?.status === "queued", bounced);

    // Re-submit, then pass the host check.
    await db.rpc("claim_council_work_item", { p_session_id: id, p_agent_name: "alpha" });
    await db.rpc("complete_council_work_item", {
        p_item_id: item.id, p_agent_name: "alpha",
        p_commit_hash: "cafebabe", p_verification: "second try",
    });
    await db.rpc("record_host_verification", { p_item_id: item.id, p_passed: true, p_report: "ok all checks" });
    const accepted = await db.rpc("review_council_work_item", {
        p_item_id: item.id, p_reviewer: "alpha", p_accepted: true, p_note: "good",
    });
    check("accepting after a passing host check succeeds", (accepted.data as { ok?: boolean })?.ok === true, accepted.data);

    const wrongReviewer = await db.rpc("review_council_work_item", {
        p_item_id: item.id, p_reviewer: "beta", p_accepted: true, p_note: "x",
    });
    check("only the closer may review", (wrongReviewer.data as { reason?: string })?.reason === "not_the_closer", wrongReviewer.data);

    // Integration is a separate gate from per-item acceptance.
    const nominated = await db.rpc("set_campaign_integrator", { p_session_id: id, p_agent: "alpha" });
    check("an integrator can be nominated once the campaign completes",
        (nominated.data as { ok?: boolean })?.ok === true, nominated.data);

    const offRoster = await db.rpc("set_campaign_integrator", { p_session_id: id, p_agent: "nobody" });
    check("an integrator off the roster is refused", (offRoster.data as { ok?: boolean })?.ok === false, offRoster.data);

    const reported = await db.rpc("record_campaign_integration", {
        p_session_id: id, p_status: "verified", p_branch: "council/x/integration", p_report: "merged clean",
    });
    check("an integration result is recorded", (reported.data as { ok?: boolean })?.ok === true, reported.data);

    const badStatus = await db.rpc("record_campaign_integration", {
        p_session_id: id, p_status: "nonsense", p_branch: null, p_report: "x",
    });
    check("an unknown integration status is refused", (badStatus.data as { ok?: boolean })?.ok === false, badStatus.data);
}

async function cleanup(): Promise<void> {
    if (created.length === 0) return;
    const { error } = await db.from("council_sessions").delete().in("id", created);
    if (error) console.warn(`cleanup failed for ${created.length} session(s): ${error.message}`);
    else console.log(`\ncleaned up ${created.length} test session(s)`);
}

async function main(): Promise<void> {
    try {
        await testMessageCap();
        await testObligations();
        await testWorkItemValidation();
        await testWorkItemLease();
        await testPause();
        await testOwnerGate();
        await testSeatKeys();
        await testHostVerification();
    } catch (err) {
        failed++;
        console.error("\naborted:", err instanceof Error ? err.message : err);
        if (err instanceof Error && /validate_council_work_items|lease_owner|max_attempts/.test(err.message)) {
            console.error("This looks like the P1 migration has not been applied yet.");
        }
    } finally {
        await cleanup();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

void main();
