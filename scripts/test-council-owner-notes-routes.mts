import assert from "node:assert/strict";
import { test } from "node:test";

// Owner notes and Requeue over their real route handlers and proxy, with a
// fixture PostgREST. No hosted database is used.

Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://notes-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", AUTH_SESSION_SECRET: "fixture-session", AUTH_ORIGIN: "https://assistant.test",
});

const SESSION = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const FOREIGN_ITEM = "44444444-4444-4444-8444-444444444444";
const NOTE = { id: "55555555-5555-4555-8555-555555555555", agent_name: null, body: "Keep the journal format.", created_at: "2026-11-21T00:00:00Z", delivered: {} };

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
const rpcs = () => calls.filter((call) => call.path.startsWith("/rest/v1/rpc/")).map((call) => call.path.slice("/rest/v1/rpc/".length));
let answers: Record<string, () => Response> = {};

globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    assert.equal(url.hostname, "notes-fixture.supabase.co", `Unexpected request to ${url.hostname}`);
    const method = init?.method ?? request?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ path: url.pathname, method, body });
    const answer = answers[url.pathname];
    if (answer) return answer();
    if (url.pathname === "/rest/v1/council_sessions") {
        return Response.json(url.searchParams.get("code") === "eq.CN-NOTE" ? { id: SESSION, code: "CN-NOTE", topic: "Fixture", status: "closed" } : null);
    }
    if (url.pathname === "/rest/v1/council_campaigns") return Response.json({ id: CAMPAIGN, session_id: SESSION, status: "blocked" });
    if (url.pathname === "/rest/v1/council_work_items") return Response.json([{ id: ITEM, campaign_id: CAMPAIGN, sequence: 1, agent_name: "seat-a", status: "blocked", acceptance_criteria: [], declared_paths: [], dependencies: [] }]);
    if (url.pathname === "/rest/v1/council_owner_notes") return Response.json([NOTE]);
    throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
};

const missingFunction = () => Response.json({ code: "PGRST202", message: "Could not find the function public.x in the schema cache" }, { status: 404 });

const notes = await import("../src/app/api/council/[code]/notes/route");
const requeue = await import("../src/app/api/council/[code]/work/[itemId]/requeue/route");
const ownerNotes = await import("../src/lib/council/owner-notes");
const { proxy } = await import("../src/proxy");
const { NextRequest } = await import("next/server");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");

const cookie = `${AUTH_COOKIE}=${await createSessionValue()}`;
const request = (path: string, init: { method?: string; body?: unknown; origin?: string; cookie?: string } = {}) => new NextRequest(`https://assistant.test${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", ...(init.origin ? { origin: init.origin } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
});
const params = (code = "CN-NOTE") => ({ params: Promise.resolve({ code }) });
const itemParams = (itemId: string, code = "CN-NOTE") => ({ params: Promise.resolve({ code, itemId }) });
const post = (body: unknown, origin = "https://assistant.test") => notes.POST(request("/api/council/CN-NOTE/notes", { body, origin, cookie }), params());

test.beforeEach(() => { calls.length = 0; answers = {}; });

test("the proxy sends signed-out callers to sign in and refuses cross-site writes", async () => {
    const toLogin = (res: Response) => res.status === 307 && new URL(res.headers.get("location")!, "https://assistant.test").pathname === "/login";
    for (const path of ["/api/council/CN-NOTE/notes", `/api/council/CN-NOTE/work/${ITEM}/requeue`]) {
        assert.ok(toLogin(await proxy(request(path, { method: "POST" }))), path);
        assert.ok(toLogin(await proxy(request(path))), path);
        assert.equal((await proxy(request(path, { method: "POST", origin: "https://evil.test", cookie }))).status, 403);
        assert.equal((await proxy(request(path, { method: "POST", origin: "https://assistant.test", cookie }))).headers.get("x-middleware-next"), "1");
    }
    assert.equal(calls.length, 0);
});

test("the routes refuse another origin before touching the database", async () => {
    assert.equal((await post({ text: "Hello" }, "https://next.assistant.test")).status, 403);
    assert.equal((await requeue.POST(request(`/api/council/CN-NOTE/work/${ITEM}/requeue`, { method: "POST", origin: "https://evil.test", cookie }), itemParams(ITEM))).status, 403);
    assert.equal(calls.length, 0);
});

test("a note is checked, trimmed and sent to all seats or one", async () => {
    for (const body of [{}, { text: "   " }, { text: "x".repeat(4001) }, { text: "Hi", agent: 7 }]) {
        assert.equal((await post(body)).status, 400);
    }
    assert.equal(calls.length, 0);

    answers["/rest/v1/rpc/add_council_owner_note"] = () => Response.json({ ok: true, note: NOTE });
    const sent = await post({ text: "  Keep the journal format.  ", agent: "" });
    assert.equal(sent.status, 200);
    assert.equal(sent.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(calls.find((call) => call.path.endsWith("/add_council_owner_note"))?.body, {
        p_session_id: SESSION, p_agent_name: null, p_body: "Keep the journal format.",
    });
    const data = await sent.json() as { note: { id: string }; installed: boolean; notes: { id: string; agentName: string | null }[] };
    assert.equal(data.note.id, NOTE.id);
    assert.deepEqual(data.notes.map((note) => [note.id, note.agentName]), [[NOTE.id, null]]);

    calls.length = 0;
    assert.equal((await post({ text: "Only you", agent: "seat-a" })).status, 200);
    assert.equal(calls.find((call) => call.path.endsWith("/add_council_owner_note"))?.body?.p_agent_name, "seat-a");
    assert.equal((await notes.POST(request("/api/council/CN-GONE/notes", { body: { text: "Hi" }, cookie }), params("CN-GONE"))).status, 404);
});

test("refusals and a missing migration read clearly", async () => {
    for (const [reason, status] of [["not_closed", 409], ["campaign_finished", 409], ["unknown_seat", 400]] as const) {
        answers["/rest/v1/rpc/add_council_owner_note"] = () => Response.json({ ok: false, reason });
        const res = await post({ text: "Hello" });
        assert.equal(res.status, status);
        assert.equal(((await res.json()) as { reason: string }).reason, reason);
    }
    answers["/rest/v1/rpc/add_council_owner_note"] = missingFunction;
    const missing = await post({ text: "Hello" });
    assert.equal(missing.status, 503);
    assert.match(((await missing.json()) as { error: string }).error, /council-owner-notes\.sql/);

    answers["/rest/v1/council_owner_notes"] = () => Response.json({ code: "42P01", message: "relation \"council_owner_notes\" does not exist" }, { status: 404 });
    const list = await notes.GET(request("/api/council/CN-NOTE/notes", { cookie }), params());
    assert.deepEqual(await list.json(), { installed: false, notes: [] });
});

test("requeue works only on a blocked task of this council", async () => {
    assert.equal((await requeue.POST(request(`/api/council/CN-NOTE/work/not-a-uuid/requeue`, { method: "POST", cookie }), itemParams("not-a-uuid"))).status, 404);
    assert.equal((await requeue.POST(request(`/api/council/CN-NOTE/work/${FOREIGN_ITEM}/requeue`, { method: "POST", cookie }), itemParams(FOREIGN_ITEM))).status, 404);
    assert.deepEqual(rpcs(), []);

    answers["/rest/v1/rpc/requeue_council_work_item"] = () => Response.json({ ok: true, item: { id: ITEM } });
    const done = await requeue.POST(request(`/api/council/CN-NOTE/work/${ITEM}/requeue`, { method: "POST", cookie }), itemParams(ITEM));
    assert.equal(done.status, 200);
    assert.deepEqual(calls.find((call) => call.path.endsWith("/requeue_council_work_item"))?.body, { p_item_id: ITEM });

    answers["/rest/v1/rpc/requeue_council_work_item"] = () => Response.json({ ok: false, reason: "not_blocked" });
    assert.equal((await requeue.POST(request(`/api/council/CN-NOTE/work/${ITEM}/requeue`, { method: "POST", cookie }), itemParams(ITEM))).status, 409);
    answers["/rest/v1/rpc/requeue_council_work_item"] = missingFunction;
    assert.equal((await requeue.POST(request(`/api/council/CN-NOTE/work/${ITEM}/requeue`, { method: "POST", cookie }), itemParams(ITEM))).status, 503);
});

test("a seat gets only the notes its own take marked, framed as from the owner", async () => {
    const other = { ...NOTE, id: "66666666-6666-4666-8666-666666666666", agent_name: "seat-a", body: "Second" };
    answers["/rest/v1/rpc/pending_council_owner_notes"] = () => Response.json([NOTE, other]);
    answers["/rest/v1/rpc/mark_council_owner_notes_delivered"] = () => Response.json([other.id]);
    const taken = await ownerNotes.takeOwnerNotes(SESSION, "seat-a");
    assert.deepEqual(taken.map((note) => note.id), [other.id], "a note another caller marked first is not delivered twice");
    assert.deepEqual(calls.find((call) => call.path.endsWith("/mark_council_owner_notes_delivered"))?.body, {
        p_ids: [NOTE.id, other.id], p_agent_name: "seat-a",
    });

    answers["/rest/v1/rpc/pending_council_owner_notes"] = () => Response.json([]);
    calls.length = 0;
    assert.deepEqual(await ownerNotes.takeOwnerNotes(SESSION, "seat-a"), []);
    assert.deepEqual(rpcs(), ["pending_council_owner_notes"]);

    answers["/rest/v1/rpc/pending_council_owner_notes"] = missingFunction;
    assert.deepEqual(await ownerNotes.takeOwnerNotes(SESSION, "seat-a"), [], "delivery degrades quietly before the migration");

    assert.equal(ownerNotes.renderOwnerNotes([{ body: "One" }, { body: "Two" }]),
        "=== OWNER NOTE (from the owner, delivered by the Zuychin server) ===\nOne\n=== END OWNER NOTE ===\n\n"
        + "=== OWNER NOTE (from the owner, delivered by the Zuychin server) ===\nTwo\n=== END OWNER NOTE ===");
});
