import assert from "node:assert/strict";
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://approval-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service", GEMINI_API_KEY: "fixture-gemini", NVIDIA_NIM_API_KEY: "fixture-nim",
    AUTH_SESSION_SECRET: "fixture-session", GITHUB_VAULT_TOKEN: "fixture-vault", GITHUB_VAULT_REPO: "fixture/vault" });
const owner = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const args = { title: "Fixture", content: "PRIVATE SOURCE" };
const { canonicalAction } = await import("../src/lib/tasks/unattended-policy");
const saved: Record<string, unknown>[] = [];
let outcome = "", generationCalls = 0;
globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined, url = new URL(req?.url ?? String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.hostname === "approval-fixture.supabase.co") {
        const endpoint = url.pathname.replace("/rest/v1/", "");
        if (endpoint === "user_profiles") return Response.json({ id: owner, preferences: { freeOnly: true } });
        if (endpoint === "rpc/assistant_decide_action") return Response.json({ claimed: true, approval: { id, task_id: id, run_id: id, user_profile_id: owner,
            task_title: "Fixture task", tool: "vault_ingest", args, args_hash: canonicalAction("vault_ingest", args).hash, instruction: "Fixture",
            source_context: "Fixture", status: "executing", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), execution_token: id } });
        if (endpoint === "rpc/assistant_finish_action") { outcome = body.p_status; return Response.json(true); }
        if (endpoint === "model_call_observations") { saved.push(...body); return new Response(null, { status: 201 }); }
        return Response.json([]);
    }
    if (url.hostname === "api.github.com") { assert.equal(init?.method ?? "GET", "GET"); return new Response(null, { status: 404 }); }
    if (url.hostname === "integrate.api.nvidia.com") return Response.json({ data: [{ embedding: Array(2048).fill(0.1) }] });
    assert.equal(url.hostname, "generativelanguage.googleapis.com"); generationCalls++;
    return Response.json({ error: { message: "Synthetic refused", code: 403 } }, { status: 403 });
};
const { POST } = await import("../src/app/api/tasks/approvals/route");
const { createSessionValue } = await import("../src/lib/auth/session");
const { AUTH_COOKIE } = await import("../src/lib/auth/config");
const { NextRequest } = await import("next/server");
const response = await POST(new NextRequest("https://fixture.invalid/api/tasks/approvals", { method: "POST",
    headers: { "content-type": "application/json", cookie: `${AUTH_COOKIE}=${await createSessionValue()}` }, body: JSON.stringify({ id, decision: "approve" }) }));
assert.equal(response.status, 200); assert.equal(outcome, "outcome_unknown"); assert.equal(generationCalls, 1);
const failed = saved.find(row => row.purpose === "extraction");
assert.ok(failed); assert.equal(failed.provider_id, "gemini"); assert.equal(failed.status, "auth"); assert.equal(failed.total_tokens, null);
assert.equal(failed.user_profile_id, owner); assert.equal(failed.message_id, null);
assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|fixture-gemini|fixture-service/);
console.log("Approval observations: actual approved vault helper failure persists safe health and retains unknown action outcome.");
