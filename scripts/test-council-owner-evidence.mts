import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerCompareCommand, parseOwnerManifest } from "../src/lib/council/owner-evidence.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = "a".repeat(40), tip = "b".repeat(40);
const manifest = { version: 1, campaignId: id(1), baseSha: base, items: [{
    itemId: id(2), sequence: 1, agentName: "reviewer", branch: "council/test/reviewer", commitSha: tip,
    verificationRunId: id(3), dependencies: [], acceptedExecutionId: null, executionEvidence: null,
}] };

test("owner comparison uses only exact SHAs and never a branch, path or merge action", () => {
    assert.equal(ownerCompareCommand(base, tip), `git diff ${base} ${tip} --`);
    for (const bad of ["main", "-C /private", "a".repeat(39), `${base};echo secret`, `${base}\n`, "$(whoami)", null]) {
        assert.equal(ownerCompareCommand(bad, tip), null);
        assert.equal(ownerCompareCommand(base, bad), null);
    }
});

test("frozen manifest projection keeps exact verification binding and strips private fields", () => {
    assert.deepEqual(parseOwnerManifest({ ...manifest, hostId: "private", items: [{ ...manifest.items[0], tokenHash: "private", env: "private" }] }), manifest);
});

test("malformed or incomplete manifests cannot produce partial verified packages", () => {
    assert.equal(parseOwnerManifest({ ...manifest, items: [{ ...manifest.items[0], commitSha: "main" }] }), null);
    assert.equal(parseOwnerManifest({ ...manifest, items: [{ ...manifest.items[0], verificationRunId: id(3) }, { ...manifest.items[0], verificationRunId: id(4) }] }), null);
    assert.equal(parseOwnerManifest({ ...manifest, version: 99 }), null);
});
