import { z } from "zod";

export interface IntegrationRedactionContext {
    secrets?: readonly string[];
    privatePaths?: readonly string[];
}

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const receiptSchema = z.object({
    command: z.array(z.string().max(2048)).min(1).max(64),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative().finite(),
    outputDigest: digestSchema,
    outputTail: z.string().max(4000),
    timedOut: z.boolean(),
}).strict();
const relativePathSchema = z.string().min(1).max(1024).refine(value =>
    !/[:\\]/.test(value) && !hasControls(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== ".."));
const refSchema = z.string().min(1).max(300).regex(/^[a-z0-9][a-z0-9/_.-]*$/i)
    .refine(value => !["__proto__", "constructor", "prototype"].includes(value));
const refsSchema = z.record(refSchema, shaSchema.nullable())
    .refine(value => Object.keys(value).length <= 64);

export const integrationEvidenceSchema = z.object({
    version: z.literal(1),
    redactionVersion: z.literal(1),
    receipts: z.array(receiptSchema).max(64),
    changedPaths: z.array(relativePathSchema).max(500).nullable(),
    diffSummary: z.string().max(16000).nullable(),
    protectedRefs: z.object({ before: refsSchema.nullable(), after: refsSchema.nullable() }).strict(),
    conflictNotes: z.string().max(8000).nullable(),
    manualChecks: z.array(z.string().max(1000)).max(32).nullable(),
}).strict();

export type IntegrationEvidence = z.infer<typeof integrationEvidenceSchema>;
export type IntegrationReceipt = IntegrationEvidence["receipts"][number];
const rawReceiptSchema = receiptSchema.extend({
    command: z.array(z.string().max(32768)).min(1).max(64),
    outputTail: z.string().max(200000),
});
const integrationInputSchema = integrationEvidenceSchema.extend({
    receipts: z.array(rawReceiptSchema).max(64),
    diffSummary: z.string().max(200000).nullable(),
    conflictNotes: z.string().max(200000).nullable(),
    manualChecks: z.array(z.string().max(16000)).max(32).nullable(),
});
const verificationInputSchema = z.array(rawReceiptSchema.extend({
    timedOut: z.boolean().optional(),
    redactionVersion: z.literal(1).optional(),
})).max(64);

function hasControls(value: string): boolean {
    return [...value].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159)
            || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    });
}

function cleanTerminalText(value: string): string {
    // Strip terminal escape sequences before matching split credential names.
    const stripped = value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    return [...stripped].filter(character => character === "\n" || character === "\t"
        || !hasControls(character)).join("");
}

const credentialName = /^(?:--?)?(?:[a-z0-9]+[-_])*(?:api[-_]?key|key|token|secret|password|passwd|credential|authorization|cookie)$/i;

export function sanitiseIntegrationText(value: string, context: IntegrationRedactionContext = {}, maxLength = 16000): string {
    let text = cleanTerminalText(value);
    const secrets = [...new Set((context.secrets ?? []).filter(Boolean)
        .flatMap(secret => [secret, encodeURIComponent(secret)]))].sort((a, b) => b.length - a.length);
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    for (const path of [...(context.privatePaths ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
        for (const variant of new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")])) {
            const pattern = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            text = text.replace(new RegExp(pattern, /^[a-z]:/i.test(path) ? "gi" : "g"), "[PRIVATE_PATH]");
        }
    }
    text = text
        .replace(/\b(?:zcs_|zck_|zch_|gh[pousr]_|github_pat_|sk-(?:proj-|ant-)?)[a-z0-9_-]{8,}/gi, "[REDACTED]")
        .replace(/\bAIza[a-z0-9_-]{20,}/gi, "[REDACTED]")
        .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, "[REDACTED]")
        .replace(/\b(?:Bearer|Basic)\s+[^\s,"'<>]+/gi, "[REDACTED]")
        .replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:[^\r\n]*/gi, "[REDACTED]")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s"'<>?#]+@/gi, "$1[REDACTED]@")
        .replace(/([?&](?:api[-_]?key|key|token|secret|password|sig|signature|access_token)=)[^&#\s"']*/gi, "$1[REDACTED]")
        .replace(/((?:--?)?(?:[a-z0-9]+[-_])*(?:api[-_]?key|key|token|secret|password|passwd|credential)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"']+)/gi, "$1[REDACTED]")
        .replace(/\b[a-z]:[\\/][^\s"'<>|]*/gi, "[PRIVATE_PATH]")
        .replace(/\\\\[^\s"'<>|]+/g, "[PRIVATE_PATH]")
        .replace(/(^|[\s("'=])\/(?!\/)[^\s"'<>|)]+/g, "$1[PRIVATE_PATH]");
    const limit = Math.max(0, Math.floor(maxLength));
    const marker = "…[truncated]";
    return text.length <= limit ? text : limit < marker.length ? marker.slice(0, limit)
        : text.slice(0, limit - marker.length) + marker;
}

function sanitiseReceipt(receipt: IntegrationReceipt, context: IntegrationRedactionContext): IntegrationReceipt {
    return {
        command: receipt.command.map((argument, index) => index > 0 && credentialName.test(receipt.command[index - 1])
            ? "[REDACTED]" : sanitiseIntegrationText(argument, context, 2048)),
        exitCode: receipt.exitCode,
        durationMs: receipt.durationMs,
        outputDigest: receipt.outputDigest.toLowerCase(),
        outputTail: sanitiseIntegrationText(receipt.outputTail, context, 4000),
        timedOut: receipt.timedOut,
    };
}

export function sanitiseVerificationReceipts(input: unknown, context: IntegrationRedactionContext = {}): (IntegrationReceipt & { redactionVersion: 1 })[] {
    const result = verificationInputSchema.safeParse(input);
    if (!result.success) throw new Error("Invalid verification receipts.");
    return result.data.map(receipt => ({
        ...sanitiseReceipt({ ...receipt, timedOut: receipt.timedOut ?? false }, context), redactionVersion: 1,
    }));
}

export function sanitiseIntegrationEvidence(input: unknown, context: IntegrationRedactionContext = {}): IntegrationEvidence {
    const result = integrationInputSchema.safeParse(input);
    if (!result.success) throw new Error("Invalid integration evidence.");
    const value = result.data;
    const exactText = [...(value.changedPaths ?? []), ...Object.keys(value.protectedRefs.before ?? {}),
        ...Object.keys(value.protectedRefs.after ?? {})];
    if (exactText.some(text => sanitiseIntegrationText(text, context) !== text)) {
        throw new Error("Invalid integration evidence.");
    }
    return {
        version: 1,
        redactionVersion: 1,
        receipts: value.receipts.map(receipt => sanitiseReceipt(receipt, context)),
        changedPaths: value.changedPaths,
        diffSummary: value.diffSummary === null ? null : sanitiseIntegrationText(value.diffSummary, context),
        protectedRefs: value.protectedRefs,
        conflictNotes: value.conflictNotes === null ? null : sanitiseIntegrationText(value.conflictNotes, context, 8000),
        manualChecks: value.manualChecks?.map(text => sanitiseIntegrationText(text, context, 1000)) ?? null,
    };
}
