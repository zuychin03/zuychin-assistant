import { z } from "zod";

export const councilWriteIdentitySchema = z.object({
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    executionId: z.string().uuid().nullable(),
}).strict();

export type CouncilWriteIdentity = z.infer<typeof councilWriteIdentitySchema>;
