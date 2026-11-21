import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://council-test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service";

const SESSION = "11111111-1111-4111-8111-111111111111";
const EXECUTION = "22222222-2222-4222-8222-222222222222";
const HOST = "44444444-4444-4444-8444-444444444444";
const TOKEN = "zcs_" + "a".repeat(64);
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const writeIdentity = { tokenHash: HASH, executionId: EXECUTION };
const network = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access"); });
const { supabaseAdmin } = await import("../src/lib/supabase.ts");
const store = await import("../src/lib/council/store.ts");
const { issueHostSeatKey } = await import("../src/lib/council/seat-keys.ts");
after(() => { assert.equal(network.mock.callCount(), 0); mock.restoreAll(); });

// A successful append refreshes participant liveness, which reads this table.
beforeEach(t => {
    assert("mock" in t);
    t.mock.method(supabaseAdmin, "from", (table: string) => {
        assert.equal(table, "council_participants");
        const query = { select: () => query, eq: () => query, order: async () => ({ data: [{ name: "seat", kind: "agent" }], error: null }) };
        return query;
    });
});

const message = { sessionId: SESSION, speaker: "seat", intent: "propose", body: "Synthetic proposal", clientKey: "test-1" };

test("seat messages pass the runner's identity to the attributed RPC", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        assert.equal(args.p_seat_token_hash, HASH);
        assert.equal(args.p_expected_execution_id, EXECUTION);
        assert.equal(name, "append_council_message_attributed");
        return { data: { ok: true, executionId: EXECUTION, round: 1 }, error: null };
    });
    assert.equal((await store.appendMessage({ ...message, identity: writeIdentity })).ok, true);
    assert.equal(rpc.mock.callCount(), 1);
});

test("moderator writes keep the unbound RPC path", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        assert(!("p_seat_token_hash" in args));
        assert.equal(name, "append_council_message");
        return { data: { ok: true, round: 1 }, error: null };
    });
    assert.equal((await store.appendMessage({ ...message, role: "moderator" })).ok, true);
    assert.equal(rpc.mock.callCount(), 1);
});

test("legacy seat identity stays null without substituting a newer execution", async t => {
    t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, "append_council_message_attributed");
        assert.equal(args.p_expected_execution_id, null);
        return { data: { ok: true, round: 1, executionId: null }, error: null };
    });
    await store.appendMessage({ ...message, identity: { tokenHash: HASH, executionId: null } });
});

test("attributed failures never retry through the legacy RPC", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async () => ({ data: null, error: { message: "synthetic unavailable" } }));
    t.mock.method(console, "error", () => undefined);
    await assert.rejects(store.appendMessage({ ...message, identity: writeIdentity }), /nothing was said/);
    assert.equal(rpc.mock.callCount(), 1);
});

test("invalid write identity is rejected before any database call", async t => {
    const rpc = t.mock.method(supabaseAdmin, "rpc", async () => { assert.fail("Invalid identity reached database"); });
    t.mock.method(console, "error", () => undefined);
    for (const identity of [{ tokenHash: "bad", executionId: EXECUTION }, { tokenHash: HASH, executionId: "bad" }]) {
        await assert.rejects(store.appendMessage({ ...message, identity }));
    }
    assert.equal(rpc.mock.callCount(), 0);
});

test("the transcript mapper preserves explicit bindings and historical nulls", async t => {
    const messageRows = [EXECUTION, null].map((id, i) => ({ seq: i + 1, execution_id: id, body: "Synthetic message" }));
    t.mock.method(supabaseAdmin, "from", (table: string) => {
        assert.equal(table, "council_messages");
        const builder = { select: (columns: string) => {
            assert(columns.includes("execution_id"));
            return builder;
        }, eq: () => builder, gt: () => builder, order: () => builder, limit: () => builder,
        then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: messageRows, error: null }).then(resolve) };
        return builder;
    });
    assert.deepEqual((await store.readTranscript({ sessionId: SESSION })).map(m => m.executionId), [EXECUTION, null]);
});

test("host issuance binds the seat to an execution only when asked", async t => {
    const names: string[] = [];
    t.mock.method(supabaseAdmin, "rpc", async (name: string, args: Record<string, unknown>) => {
        names.push(name);
        assert.match(String(args.p_token_hash), /^[0-9a-f]{64}$/);
        assert.equal(args.p_host_id, HOST);
        return { data: { ok: true, executionBindingRequired: name === "issue_council_bound_host_seat_key" }, error: null };
    });
    const host = { scopes: ["council:host"] };
    const bound = await issueHostSeatKey({ sessionId: SESSION, seatName: "seat", hostId: HOST, leaseEpoch: 1, bindExecution: true }, host);
    const loose = await issueHostSeatKey({ sessionId: SESSION, seatName: "seat", hostId: HOST, leaseEpoch: 1 }, host);
    assert.deepEqual(names, ["issue_council_bound_host_seat_key", "issue_council_host_seat_key"]);
    assert(bound.ok && bound.executionBindingRequired === true && bound.token.startsWith("zcs_"));
    assert(loose.ok && loose.executionBindingRequired === undefined);
    await assert.rejects(issueHostSeatKey({ sessionId: SESSION, seatName: "seat", hostId: HOST, leaseEpoch: 1 }, { scopes: ["council:owner"] }));
});
