import { NextRequest, NextResponse, after } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { PROVIDERS } from "@/lib/ai/providers";
import { catalogueModelRef } from "@/lib/ai/catalogue/rows";
import { readCatalogueRows } from "@/lib/ai/catalogue/store";
import { refreshCatalogueSnapshot } from "@/lib/ai/catalogue/snapshot";
import { startFailure } from "@/lib/ai/catalogue/run";
import { parseTagList, profileFromJson, type ModelProfile } from "@/lib/ai/models/profiles";
import { tagBlockedReason, TAG_INFO, type PurposeTag } from "@/lib/ai/models/tags";
import { capsOf } from "@/lib/ai/models/view";
import { rowModel } from "@/lib/ai/models/admin-view";
import { approveProfile, readProfile } from "@/lib/ai/models/store";
import { getVaultConfig } from "@/lib/vault/github";
import { BodyTooLargeError, bodyFailure, readJsonCapped } from "@/lib/http/body";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * One request for each dashboard action: Approve (model, profile and tags), Approve profile, and Save tags.
 * Sources are kept only when the lookup fetched them, so an edited profile cannot add links.
 */
export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    let body: unknown = null;
    try { body = await readJsonCapped(req); } catch (error) { if (error instanceof BodyTooLargeError) return bodyFailure(error)!; }
    const ref = catalogueModelRef(body);
    if (!ref) return bad("Send providerId and modelId.");
    const input = body as { tags?: unknown; profile?: unknown; approveModel?: unknown };
    const tags = input.tags === undefined ? null : parseTagList(input.tags);
    if (input.tags !== undefined && !tags) return bad("Tags must come from the purpose list.");
    const approveModel = input.approveModel === true;
    const provider = PROVIDERS.find((entry) => entry.id === ref.providerId);
    if (!provider) return bad("Unknown provider.", 404);
    try {
        const stored = await readCatalogueRows();
        if (!stored.ok) {
            const failure = startFailure(stored.reason);
            return bad(failure.error, failure.status);
        }
        const row = stored.rows.find((entry) => entry.providerId === ref.providerId && entry.modelId === ref.modelId);
        if (!row) return bad("That model is not in the catalogue.", 404);
        const model = rowModel(row, provider.chatModels.find((entry) => entry.id === row.modelId));
        const blocked = (tags ?? []).flatMap((tag: PurposeTag) => {
            const reason = tagBlockedReason(tag, capsOf(model));
            return reason ? [`${TAG_INFO[tag].label}: ${reason.toLowerCase()}`] : [];
        });
        if (blocked.length) return bad(`This model cannot carry ${blocked.join("; ")}.`);

        const existing = await readProfile(ref.providerId, ref.modelId).catch(() => undefined);
        if (existing === undefined) return bad("The model profile table is missing or unavailable. Apply scripts/migrations/v7-model-awareness.sql.", 503);
        let profile: ModelProfile | null = null;
        if (input.profile !== undefined && input.profile !== null) {
            const fetched = new Set([...(existing?.draft?.sources ?? []), ...(existing?.profile?.sources ?? [])].map((source) => source.url));
            profile = profileFromJson(input.profile, fetched);
            if (!profile) return bad("A profile needs a description.");
        }
        if (!tags && !profile && !approveModel) return bad("Nothing to save.");
        const finalTags = tags ?? existing?.tags ?? [];
        if ((profile || approveModel) && !finalTags.length) return bad("Choose at least one purpose tag before approving.");

        const result = await approveProfile(ref.providerId, ref.modelId, { tags, profile, approveModel });
        if (result === "not_found") return bad("That model is not in the catalogue.", 404);
        if (result !== "ok") {
            return result === "migration_required"
                ? bad("The model profile table is missing. Apply scripts/migrations/v7-model-awareness.sql.", 503)
                : bad("The profile could not be saved. Please retry.", 503);
        }
        await refreshCatalogueSnapshot();
        if (getVaultConfig() && (profile || (tags && existing?.profile && existing.approvedAt))) {
            after(async () => {
                const { syncModelVault } = await import("@/lib/ai/models/vault-sync");
                await syncModelVault(ref.providerId, ref.modelId);
            });
        }
        return NextResponse.json({ ok: true, ...ref, tags: finalTags, profileApproved: profile !== null || !!existing?.approvedAt, modelApproved: approveModel || row.approvedAt !== null });
    } catch (error) {
        console.error("[ModelProfiles] Approval failed:", error instanceof Error ? error.message : error);
        return bad("The profile could not be saved. Please retry.", 500);
    }
}
