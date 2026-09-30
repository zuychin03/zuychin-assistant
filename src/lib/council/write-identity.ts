import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { isCouncilOwner } from "@/lib/agents/scopes";

export const councilWriteIdentitySchema = z.object({
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    executionId: z.string().uuid().nullable(),
}).strict();

export type CouncilWriteIdentity = z.infer<typeof councilWriteIdentitySchema>;

export function getCouncilWriteIdentity(auth: AuthInfo | undefined): CouncilWriteIdentity | undefined {
    if (isCouncilOwner(auth?.scopes)) return undefined;
    if (!auth?.scopes.includes("council:seat") || !auth.clientId.startsWith("council-seat:")
        || !/^zcs_[a-f0-9]{64}$/.test(auth.token)) {
        throw new Error("A verified Council seat credential is required.");
    }
    const executionId = auth.extra?.councilExecutionId ?? null;
    if (auth.extra?.councilExecutionBindingRequired === true && executionId === null) {
        throw new Error("This seat is waiting for its execution binding.");
    }
    return councilWriteIdentitySchema.parse({
        tokenHash: createHash("sha256").update(auth.token).digest("hex"), executionId,
    });
}
