import type { ChatModel } from "@/lib/ai/providers";
import type { CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { modelSpeed, type FeedbackCount, type ModelFeedback, type ModelSpeed, type SpeedStats } from "@/lib/ai/models/stats";
import { capsOf, measuredFacts, resolveTags } from "@/lib/ai/models/view";
import { PURPOSE_TAGS, tagBlockedReason, type PurposeTag, type TagsSource } from "@/lib/ai/models/tags";
import type { ProfileRecord } from "@/lib/ai/models/profiles";

export type AdminProfile = Omit<ProfileRecord, "providerId" | "modelId" | "tags" | "tagsSource">;

export interface AdminModelInfo {
    tags: PurposeTag[];
    tagsSource: TagsSource;
    /** Tags this route cannot carry, with the reason shown on the disabled chip. */
    blockedTags: Partial<Record<PurposeTag, string>>;
    speed: ModelSpeed;
    measured: string[];
    feedback: FeedbackCount | null;
    profile: AdminProfile | null;
}

/** The code model when there is one, else a model built from the stored row and its test results. */
export function rowModel(row: CatalogueRow, code: ChatModel | undefined): ChatModel {
    if (code) return code;
    return {
        id: row.modelId, label: row.label, name: row.shortName, free: row.free,
        supportsTools: row.supportsTools === true, supportsVision: row.supportsVision === true,
        supportsThinking: row.supportsThinking === true, supportsSearch: row.supportsSearch === true,
        catalogue: {
            origin: row.origin, approved: row.approvedAt !== null,
            status: row.missingSince ? "missing" : row.probeStatus === "failed" ? "failing" : null, probeChatMs: row.probeChatMs,
        },
    };
}

export function adminModelInfo(row: CatalogueRow, model: ChatModel, profile: ProfileRecord | undefined, stats: SpeedStats | undefined, feedback: ModelFeedback | undefined): AdminModelInfo {
    const speed = modelSpeed(stats, row.probeChatMs);
    const { tags, source } = resolveTags(model, profile, row);
    const blockedTags: Partial<Record<PurposeTag, string>> = {};
    for (const tag of PURPOSE_TAGS) {
        const reason = tagBlockedReason(tag, capsOf(model));
        if (reason) blockedTags[tag] = reason;
    }
    const rest: AdminProfile | null = profile ? {
        profile: profile.profile, approvedAt: profile.approvedAt, draft: profile.draft, draftStatus: profile.draftStatus, draftError: profile.draftError,
        draftedAt: profile.draftedAt, lookupAttempts: profile.lookupAttempts, vaultPath: profile.vaultPath, vaultSyncedAt: profile.vaultSyncedAt, vaultError: profile.vaultError,
    } : null;
    return { tags, tagsSource: source, blockedTags, speed, measured: measuredFacts(model, row, speed), feedback: feedback?.all ?? null, profile: rest };
}
