import assert from "node:assert/strict";
import { createBranchRequest } from "../src/lib/conversations/branch-request";

const parent = "11111111-1111-4111-8111-111111111111";
const message = "22222222-2222-4222-8222-222222222222";
const child = "33333333-3333-4333-8333-333333333333";
const sent: string[] = [];
const original = globalThis.fetch;
let count = 0;
globalThis.fetch = async (_url, init) => {
    sent.push(String(init?.body));
    count++;
    if (count === 1) throw new TypeError("Acknowledgement lost after commit");
    return Response.json({ conversation: { id: child } });
};
try {
    const attempt = createBranchRequest(parent, message);
    const first = attempt();
    assert.equal(attempt(), first);
    await assert.rejects(first, /Acknowledgement/);
    assert.equal(await attempt(), child);
    assert.equal(sent[0], sent[1]);
    assert.equal(await attempt(), child);
    assert.equal(count, 2);
    const body = JSON.parse(sent[0]);
    assert.equal(body.conversationId, parent);
    assert.equal(body.messageId, message);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    globalThis.fetch = async () => Response.json({ conversation: { id: "invalid" } });
    await assert.rejects(createBranchRequest(parent, message)(), /incomplete/);
    globalThis.fetch = async () => Response.json({ error: "History changed. Refresh." }, { status: 409 });
    await assert.rejects(createBranchRequest(parent, message)(), /History changed/);
    console.log("9 branch request identity, retry and malformed-response checks passed.");
} finally { globalThis.fetch = original; }
