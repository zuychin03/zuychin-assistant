import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

type Decision = { decision: string; code: string; expiresAt?: string | null };
interface Fixture { name: string; input: Record<string, unknown>; expected: Decision }
const corpus = JSON.parse(readFileSync(new URL("../fixtures/council/policy-v1.json", import.meta.url), "utf8")) as {
    cases: Fixture[]; lifetimeCases: Fixture[];
    reviewLifecycle: {
        baseCases: string[];
        cases: { name: string; campaignStatus: string | null; integrationStatus: string | null; expected: Decision }[];
    };
};
const modulePath = "../src/lib/council/policy-v1.ts";
let reference: {
    authorizeCouncilV1: (input: unknown) => Decision;
    evaluateSeatLifetimeV1: (input: unknown) => Decision;
} | undefined;
try { reference = await import(modulePath); }
catch (error) {
    if (!process.argv.includes("--baseline") || (error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
}
if (process.argv.includes("--baseline")) {
    test("the approved reference policy is callable without a route, database or host", () => {
        assert.equal(typeof reference?.authorizeCouncilV1, "function");
        assert.equal(typeof reference?.evaluateSeatLifetimeV1, "function");
    });
} else {
    assert.ok(reference);
    for (const [key, evaluate] of [
        ["cases", reference.authorizeCouncilV1],
        ["lifetimeCases", reference.evaluateSeatLifetimeV1],
    ] as const) {
        for (const fixture of corpus[key]) test(fixture.name, () => {
            const before = structuredClone(fixture.input);
            assert.deepEqual(evaluate(fixture.input), fixture.expected);
            assert.deepEqual(fixture.input, before, "policy evaluation must not mutate evidence");
        });
    }

    for (const baseCase of corpus.reviewLifecycle.baseCases) {
        const base = corpus.cases.find(fixture => fixture.name === baseCase);
        assert.ok(base, baseCase);
        for (const lifecycle of corpus.reviewLifecycle.cases) test(`review lifecycle: ${baseCase}, ${lifecycle.name}`, () => {
            const input = structuredClone(base.input);
            Object.assign(input.context as Record<string, unknown>, {
                sessionStatus: "open", campaignStatus: lifecycle.campaignStatus, integrationStatus: lifecycle.integrationStatus,
            });
            const before = structuredClone(input);
            assert.deepEqual(reference!.authorizeCouncilV1(input), lifecycle.expected);
            assert.deepEqual(input, before);
        });
        test(`review lifecycle preserves separate worktree restrictions: ${baseCase}`, () => {
            const input = structuredClone(base.input);
            Object.assign(input.principal as Record<string, unknown>, { identityAssurance: "verified_seat", hostFence: null });
            (input.grant as Record<string, unknown>).hostFence = null;
            const context = input.context as Record<string, unknown>;
            Object.assign(context, { sessionStatus: "open", lease: null });
            (context.resourceFacts as Record<string, unknown>).protectedRef = true;
            assert.deepEqual(reference!.authorizeCouncilV1(input), { decision: "allow", code: "allowed" });
        });
    }

    test("unrelated connector or role changes cannot rescue a denied task grant", () => {
        const fixture = corpus.cases.find(row => row.name === "work item action is missing")!;
        for (const connector of ["acp", "mcp", "managed_api", "managed_cli", "text_only", "manual"]) {
            for (const role of ["member", "reviewer", "closer", "integrator"]) {
                const input = structuredClone(fixture.input);
                (input.connector as Record<string, unknown>).kind = connector;
                (input.principal as Record<string, unknown>).role = role;
                assert.deepEqual(reference!.authorizeCouncilV1(input), { decision: "deny", code: "task_denied" });
            }
        }
    });

    test("unrelated capability upgrades do not supply missing filesystem mediation", () => {
        const fixture = corpus.cases.find(row => row.name === "missing filesystem mediation")!;
        const input = structuredClone(fixture.input);
        const connector = input.connector as Record<string, unknown>;
        Object.assign(connector, { streaming: true, cancellation: true, sessionResume: true, modelSelection: true,
            structuredActions: true, toolCalls: true, permissionCallbacks: true, networkMediated: true });
        assert.deepEqual(reference!.authorizeCouncilV1(input), { decision: "deny", code: "unmediated_filesystem" });
    });

    test("equivalent mediated actions have the same decision across ACP, API and CLI", () => {
        const fixture = corpus.cases.find(row => row.name === "assigned and mediated write is allowed")!;
        for (const kind of ["acp", "managed_api", "managed_cli"]) {
            const input = structuredClone(fixture.input);
            (input.connector as Record<string, unknown>).kind = kind;
            assert.deepEqual(reference!.authorizeCouncilV1(input), { decision: "allow", code: "allowed" });
        }
    });

    test("non-object reference inputs never throw or grant authority", () => {
        for (const input of [undefined, null, [], false, 1, "approved"]) {
            assert.deepEqual(reference!.authorizeCouncilV1(input), { decision: "deny", code: "invalid_input" });
            assert.deepEqual(reference!.evaluateSeatLifetimeV1(input), { decision: "deny", code: "invalid_input", expiresAt: null });
        }
    });

    test("neutral role, connector, action, resource and approval matrix", () => {
        const matrix = JSON.parse(readFileSync(new URL("../fixtures/council/policy-matrix-v1.json", import.meta.url), "utf8")) as {
            connectors: string[];
            rows: { baseCase: string; expected: [string, string, string, string, string][] }[];
        };
        const resources = new Map<string, Record<string, unknown>>();
        for (const fixture of corpus.cases.filter(item => item.expected.decision === "allow")) {
            const resource = fixture.input.resource as Record<string, unknown>;
            if (!resources.has(String(resource.kind))) resources.set(String(resource.kind), resource);
        }
        for (const row of matrix.rows) {
            const base = corpus.cases.find(fixture => fixture.name === row.baseCase);
            assert.ok(base, row.baseCase);
            for (const connector of matrix.connectors) {
                for (const [role, kind, approvalState, decision, code] of row.expected) {
                    const input: Record<string, unknown> = structuredClone(base.input);
                    const principal = input.principal as Record<string, unknown>;
                    principal.role = role;
                    (input.connector as Record<string, unknown>).kind = connector;
                    const resource = structuredClone(resources.get(kind)!);
                    assert.ok(resource, kind);
                    input.resource = resource;
                    const context = input.context as Record<string, unknown>;
                    (context.resourceFacts as Record<string, unknown>).resourceId = resource.id;
                    context.approval = {
                        state: approvalState,
                        action: approvalState === "not_required" ? null : input.action,
                        resourceId: approvalState === "not_required" ? null : resource.id,
                        participantId: approvalState === "not_required" ? null : principal.participantId,
                    };
                    assert.deepEqual(reference!.authorizeCouncilV1(input), { decision, code },
                        JSON.stringify({ base: row.baseCase, connector, role, kind, approvalState }));
                }
            }
        }
    });
}
