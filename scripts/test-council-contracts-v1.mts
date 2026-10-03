import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface Fixture {
    name: string;
    kind: string;
    input: Record<string, unknown>;
    expected: { ok: boolean; code?: string };
}
const corpus = JSON.parse(readFileSync(new URL("../fixtures/council/contracts-v1.json", import.meta.url), "utf8")) as {
    cases: Fixture[];
};

if (process.argv.includes("--baseline")) {
    const { capabilitySchema } = await import("../src/lib/council/host-contracts.ts");
    for (const fixture of corpus.cases.filter(row => row.kind === "connector_snapshot"
        && (row.name.includes("future version") || row.name.includes("unknown authority")))) {
        test(fixture.name, () => assert.equal(capabilitySchema.safeParse(fixture.input).success, fixture.expected.ok));
    }
} else {
    const modulePath = "../src/lib/council/contracts-v1.ts";
    const contracts = await import(modulePath) as {
        parseCouncilContractV1: (kind: string, input: unknown) => { ok: boolean; code?: string; value?: unknown };
    };
    for (const fixture of corpus.cases) {
        test(fixture.name, () => {
            const before = structuredClone(fixture.input);
            const result = contracts.parseCouncilContractV1(fixture.kind, fixture.input);
            assert.equal(result.ok, fixture.expected.ok);
            if (fixture.expected.ok) assert.deepEqual(result.value, fixture.input, "valid envelopes must not lose evidence");
            else assert.equal(result.code, fixture.expected.code);
            assert.deepEqual(fixture.input, before, "validation must not mutate caller data");
        });
    }

    test("unknown contract families and non-object envelopes fail closed", () => {
        assert.deepEqual(contracts.parseCouncilContractV1("future_contract", {}), { ok: false, code: "unknown_contract" });
        for (const input of [null, [], "{}", 1]) {
            assert.deepEqual(contracts.parseCouncilContractV1("principal", input), { ok: false, code: "invalid_contract" });
        }
    });

    test("invalid version representations cannot select the V1 parser", () => {
        const principal = corpus.cases.find(row => row.name === "accept principal")!.input;
        for (const version of [undefined, null, "1", 0, -1, 1.5]) {
            const input = { ...principal, schemaVersion: version };
            assert.deepEqual(contracts.parseCouncilContractV1("principal", input), { ok: false, code: "unsupported_version" });
        }
    });

    test("non-finite delivery budgets are rejected outside JSON transport too", () => {
        const delivery = corpus.cases.find(row => row.name === "accept delivery")!.input;
        const input = structuredClone(delivery);
        (input.budgets as Record<string, unknown>).deadlineMs = Infinity;
        assert.equal(contracts.parseCouncilContractV1("delivery", input).ok, false);
    });
}
