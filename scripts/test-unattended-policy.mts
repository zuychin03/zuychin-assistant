import assert from "node:assert/strict";
import { canonicalAction, unattendedDisposition, withUnattendedRun, withApprovedAction, gateUnattendedTool, recordUnattendedSource } from "../src/lib/tasks/unattended-policy";

let checks = 0;
async function check(name: string, fn: () => unknown) { await fn(); checks++; console.log("PASS " + name); }
const run = { runId: "run", taskId: "task", taskTitle: "Fixture", instruction: "Review inbox", userProfileId: "owner" };
const proposals: unknown[] = [];
const propose = async (input: unknown) => { proposals.push(input); return { id: "approval", status: "pending" as const }; };
await check("nested argument hashes ignore key order but retain nested values", () => {
    assert.equal(canonicalAction("send_email", { b: { x: 1, y: 2 }, a: 3 }).hash, canonicalAction("send_email", { a: 3, b: { y: 2, x: 1 } }).hash);
    assert.notEqual(canonicalAction("send_email", { b: { x: 1 } }).hash, canonicalAction("send_email", { b: { x: 2 } }).hash);
});
await check("unsupported argument shapes cannot be journalled", () => {
    for (const args of [{ a: undefined }, { a: NaN }, { a: new Date() }, { a: BigInt(1) }]) assert.throws(() => canonicalAction("send_email", args), /arguments/i);
});
await check("read-only calls and list actions remain usable", () => {
    for (const tool of ["read_email", "search_web", "vault_read"]) assert.equal(unattendedDisposition(tool, {}), "read");
    assert.equal(unattendedDisposition("manage_notes", { action: "list" }), "read");
    assert.equal(unattendedDisposition("manage_notes", { action: "delete" }), "approval");
});
await check("Council and unknown tools cannot acquire unattended authority", () => {
    assert.equal(unattendedDisposition("council_close", {}), "deny");
    assert.equal(unattendedDisposition("future_unclassified", {}), "deny");
});
await check("interactive calls retain current dispatch", async () => assert.equal(await gateUnattendedTool("send_email", {}, propose), null));
await check("scheduled mutation proposes before any dispatch", async () => {
    proposals.length = 0;
    const result = await withUnattendedRun(run, () => gateUnattendedTool("send_email", { to: "fixture@example.invalid", body: "Hi" }, propose));
    assert.match(result!, /Awaiting your approval/);
    assert.equal(proposals.length, 1);
});
await check("review links use the configured address, never the per-deployment host", async () => {
    const keys = ["NEXT_PUBLIC_BASE_URL", "AUTH_ORIGIN", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const reply = async (env: Partial<Record<(typeof keys)[number], string>>) => {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, env);
        return (await withUnattendedRun(run, () => gateUnattendedTool("send_email", {}, propose)))!;
    };
    const link = async (env: Partial<Record<(typeof keys)[number], string>>) => /\]\(([^)]+)\)/.exec(await reply(env))![1];
    try {
        assert.equal(await link({ NEXT_PUBLIC_BASE_URL: "https://assistant.example/", AUTH_ORIGIN: "http://localhost:3000" }), "https://assistant.example/tasks?approval=approval");
        assert.equal(await link({ AUTH_ORIGIN: "https://owner.example" }), "https://owner.example/tasks?approval=approval");
        assert.equal(await link({ VERCEL_PROJECT_PRODUCTION_URL: "assistant.example", VERCEL_URL: "assistant-abc123.vercel.app" }), "https://assistant.example/tasks?approval=approval");
        assert.equal(await link({ VERCEL_URL: "assistant-abc123.vercel.app" }), "/tasks?approval=approval");
        const { convert } = await import("telegram-markdown-v2");
        assert.ok(convert(await reply({ NEXT_PUBLIC_BASE_URL: "https://assistant.example" })).includes("(https://assistant.example/tasks?approval=approval)"),
            "Telegram's MarkdownV2 conversion drops relative links, so the review link must arrive absolute");
    } finally {
        for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
});
await check("proposal outage refuses the action", async () => {
    const result = await withUnattendedRun(run, () => gateUnattendedTool("send_email", {}, async () => { throw new Error("storage"); }));
    assert.match(result!, /not executed/i);
});
await check("approved scope permits only exact immutable action once", async () => {
    const action = canonicalAction("send_email", { body: "approved" });
    await withApprovedAction({ ...run, tool: "send_email", argsHash: action.hash }, async () => {
        assert.match((await gateUnattendedTool("send_email", { body: "changed" }, propose))!, /not authorised/i);
        assert.equal(await gateUnattendedTool("send_email", { body: "approved" }, propose), null);
        assert.match((await gateUnattendedTool("send_email", { body: "approved" }, propose))!, /already used/i);
    });
});
await check("parallel scopes cannot share approval authority", async () => {
    const results = await Promise.all([
        withUnattendedRun(run, () => gateUnattendedTool("send_email", {}, propose)),
        gateUnattendedTool("send_email", {}, propose),
    ]);
    assert.match(results[0]!, /Awaiting/); assert.equal(results[1], null);
});
await check("source context is bounded and records preceding read results", async () => {
    proposals.length = 0;
    await withUnattendedRun(run, async () => {
        recordUnattendedSource("read_email", "quoted source ".repeat(3000));
        await gateUnattendedTool("send_email", {}, propose);
    });
    const proposal = proposals[0] as { sourceContext: string };
    assert.ok(proposal.sourceContext.includes("read_email"));
    assert.ok(proposal.sourceContext.length <= 16000);
});
console.log(`Unattended policy: ${checks} checks passed.`);
