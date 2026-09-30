import assert from "node:assert/strict";
import { test } from "node:test";
import {
    integrationEvidenceSchema, sanitiseIntegrationEvidence, sanitiseIntegrationText,
    sanitiseVerificationReceipts,
} from "../src/lib/council/integration-evidence.ts";

const sha = "a".repeat(40);
const digest = "b".repeat(64);
const receipt = () => ({ command: ["npm", "test"], exitCode: 0, durationMs: 123,
    outputDigest: digest, outputTail: "2 tests passed", timedOut: false });
const evidence = () => ({ version: 1, redactionVersion: 1, receipts: [receipt()],
    changedPaths: ["src/a.ts", "docs/space name.md"], diffSummary: "2 files changed",
    protectedRefs: { before: { main: sha }, after: { main: sha } },
    conflictNotes: null, manualChecks: null });

test("keeps exact useful evidence and records receipt redaction version", () => {
    assert.deepEqual(sanitiseIntegrationEvidence(evidence()), evidence());
    assert.deepEqual(sanitiseVerificationReceipts([receipt()]), [{ ...receipt(), redactionVersion: 1 }]);
});

test("redacts known secrets before clipping, including encoded forms", () => {
    const secret = "synthetic secret/value";
    const input = `prefix ${secret} ${encodeURIComponent(secret)} suffix`;
    const output = sanitiseIntegrationText(input, { secrets: [secret] }, 45);
    assert.ok(!output.includes("synthetic"));
    assert.ok(output.length <= 45);
    assert.match(output, /REDACTED/);
});

test("redacts bearer, JWT, provider, Council and GitHub token families", () => {
    const values = ["zcs_" + "c".repeat(64), "zck_" + "d".repeat(64),
        "sk-proj-" + "x".repeat(30), "ghp_" + "y".repeat(36), "github_pat_" + "z".repeat(30),
        "eyJhbGciOiJIUzI1NiJ9.eyJmb28iOiJiYXIifQ.synthetic_signature"];
    const output = sanitiseIntegrationText(`Bearer arbitrary-fixture-token ${values.join(" ")}`);
    for (const value of values) assert.ok(!output.includes(value));
    assert.ok(!output.includes("arbitrary-fixture-token"));
});

test("redacts credential assignments, URLs, header and split command arguments", () => {
    const output = sanitiseIntegrationEvidence({ ...evidence(), receipts: [{ ...receipt(),
        command: ["runner", "--api-key", "separate-fixture", "--token=inline-fixture", "--password", "-dash-fixture"],
        outputTail: 'API_KEY="quoted fixture" token=plain-fixture https://user:pass@example.test/x?key=query-fixture&ok=1\nAuthorization: Basic abcdef123\nCookie: sid=cookie-fixture',
    }] });
    const text = JSON.stringify(output);
    for (const secret of ["separate-fixture", "inline-fixture", "-dash-fixture", "quoted fixture", "plain-fixture", "user:pass", "query-fixture", "abcdef123", "cookie-fixture"]) {
        assert.ok(!text.includes(secret), secret);
    }
    assert.match(text, /example.test/);
});

test("redacts configured and recognised private absolute paths without damaging relative paths", () => {
    const text = sanitiseIntegrationText('C:\\Users\\fixture\\repo\\file.ts /home/fixture/repo/a.ts /Users/fixture/a.ts /tmp/build/a.ts D:/custom/repo/src/a.ts src/a.ts',
        { privatePaths: ["D:/custom/repo"] });
    for (const part of ["fixture", "D:/custom/repo", "/tmp/build"]) assert.ok(!text.includes(part));
    assert.match(text, /src\/a.ts/);
});

test("redacts non-HTTP credential URLs and arbitrary POSIX absolute paths", () => {
    const input = "postgres://synthetic-user:synthetic-password@localhost/db redis://:synthetic-password@localhost:6379 postgres://user:synthetic@private-password@localhost/db /srv/private-project/config.json https://example.test/path src/a.ts";
    const output = sanitiseIntegrationText(input);
    assert.ok(!output.includes("synthetic-password"));
    assert.ok(!output.includes("private-password"));
    assert.ok(!output.includes("private-project"));
    assert.match(output, /https:\/\/example.test\/path/);
    assert.match(output, /src\/a.ts/);
});

test("removes terminal control sequences and bidi spoofing before redaction", () => {
    const text = sanitiseIntegrationText("\u001b[31mAPI_\u001b[0mKEY=hidden-fixture\u202e\u0000\nvalid\ttext\u001b]8;;https://example.test\u0007label\u001b]8;;\u0007");
    assert.ok(!text.includes("hidden-fixture"));
    assert.ok(!/[\u0000\u001b\u202e]/.test(text));
    assert.match(text, /valid\ttext/);
});

test("preserves missing and failed observations without manufacturing verification", () => {
    const input = { ...evidence(), receipts: [{ ...receipt(), exitCode: null, timedOut: true }],
        changedPaths: null, diffSummary: null, protectedRefs: { before: null, after: null } };
    assert.deepEqual(sanitiseIntegrationEvidence(input), input);
});

test("rejects oversized arrays and malformed paths without echoing input", () => {
    const invalid = [
        { ...evidence(), receipts: Array.from({ length: 65 }, receipt) },
        { ...evidence(), changedPaths: Array(501).fill("a.ts") },
        ...["../secret", "src/../secret", "C:/secret", "/secret", "a\\secret", "a\nsecret", "./a"].map(path => ({ ...evidence(), changedPaths: [path] })),
        { ...evidence(), receipts: [{ ...receipt(), outputDigest: "private-invalid-value" }] },
        { ...evidence(), protectedRefs: { before: { main: "invalid" }, after: { main: sha } } },
    ];
    for (const input of invalid) assert.throws(() => sanitiseIntegrationEvidence(input), /^Error: Invalid integration evidence\.$/);
});

test("rejects unknown nested fields and missing version instead of carrying secrets", () => {
    for (const input of [{ ...evidence(), rawToken: "private" },
        { ...evidence(), receipts: [{ ...receipt(), rawToken: "private" }] },
        { ...evidence(), redactionVersion: undefined }]) {
        assert.equal(integrationEvidenceSchema.safeParse(input).success, false);
    }
});

test("fails closed when secret or private text appears in exact path metadata", () => {
    assert.throws(() => sanitiseIntegrationEvidence({ ...evidence(), changedPaths: ["src/known-fixture.ts"] },
        { secrets: ["known-fixture"] }), /Invalid integration evidence/);
});

test("sanitising twice is stable and does not mutate input", () => {
    const input = evidence();
    input.receipts[0].outputTail = "API_KEY=fixture-value";
    const snapshot = structuredClone(input);
    const output = sanitiseIntegrationEvidence(input);
    assert.deepEqual(sanitiseIntegrationEvidence(output), output);
    assert.deepEqual(input, snapshot);
});

test("redacts and bounds verbose raw command output before validating stored evidence", () => {
    const input = { ...evidence(), receipts: [{ ...receipt(),
        command: ["runner", "x".repeat(4096)], outputTail: "API_KEY=fixture-secret\n" + "line\n".repeat(4800),
    }], diffSummary: "file.ts | 1 +\n".repeat(1500) };
    const output = sanitiseIntegrationEvidence(input);
    assert.ok(output.receipts[0].outputTail.length <= 4000);
    assert.ok(output.receipts[0].command[1].length <= 2048);
    assert.ok(output.diffSummary!.length <= 16000);
    assert.ok(!JSON.stringify(output).includes("fixture-secret"));
    assert.ok(integrationEvidenceSchema.safeParse(output).success);
    assert.ok(sanitiseVerificationReceipts(input.receipts)[0].outputTail.length <= 4000);
});
