import { supabaseAdmin as db } from "@/lib/supabase";
import { commitFiles, getBranchHead, getFile, requireVaultConfig } from "@/lib/vault/github";
import { indexKnowledgeDocument } from "@/lib/knowledge/store";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import { assertFreeModel, effectiveFreeOnly } from "@/lib/ai/model-policy";
import { resolveOwnerProfile } from "@/lib/owner-profile";
import { CaptureError, createCaptureService } from "./service";
import { acquireSlot } from "./extract/gate";
import { ocrTiers } from "./extract/ocr";
import type { CaptureExtract, CaptureExtractStatus, CaptureItem } from "./types";

export async function captureProfile() {
    const profile = await resolveOwnerProfile(AbortSignal.timeout(10_000)).catch(() => null);
    if (!profile) throw new CaptureError("Your profile is unavailable. Reconnect before saving or synchronising.", 503);
    return profile;
}
interface Row {
    id: string; profile_id: string; source: CaptureItem["source"]; source_hash: string; created_at: string; receipt: CaptureItem["receipt"];
    extract?: CaptureExtract | null; extract_status?: CaptureExtractStatus | null;
}
const item = (row: Row): CaptureItem => ({ id: row.id, profileId: row.profile_id, source: row.source, sourceHash: row.source_hash, createdAt: row.created_at, receipt: row.receipt,
    ...(row.extract !== undefined ? { extract: row.extract } : {}), ...(row.extract_status !== undefined ? { extractStatus: row.extract_status } : {}) });
// Until v7-capture-extract.sql is applied the column is absent, and the inbox must keep working.
const missingExtractColumn = (error: { code?: string; message?: string }) => error.code === "42703" || error.code === "PGRST204" || /\bextract\b/.test(error.message ?? "");
export async function getCapture(profile: string, id: string) {
    const { data, error } = await db.from("capture_inbox").select("*").eq("profile_id", profile).eq("id", id).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
    if (error) throw new CaptureError("The capture inbox is unavailable. Check the capture migration and retry.", 503);
    return data ? item(data as Row) : null;
}
const LIST_COLUMNS = "id,profile_id,source_hash,created_at,receipt,kind:source->>kind,title:source->>title,text:source->>text,url:source->>url,pdf_name:source->pdf->>name,image_name:source->image->>name,source_ref:source->source";
export async function listCaptures(profile: string) {
    const list = (columns: string) => db.from("capture_inbox").select(columns)
        .eq("profile_id", profile).order("created_at", { ascending: false }).limit(100).abortSignal(AbortSignal.timeout(10_000));
    let { data, error } = await list(`${LIST_COLUMNS},extract_status:extract->>status`);
    if (error && missingExtractColumn(error)) ({ data, error } = await list(LIST_COLUMNS));
    if (error) throw new CaptureError("The capture inbox is unavailable. Check the capture migration and retry.", 503);
    return ((data ?? []) as unknown as Record<string, string | null>[]).map(row => item({ ...row, source: { kind: row.kind, title: row.title, text: row.text,
        ...(row.url ? { url: row.url } : {}), ...(row.pdf_name ? { pdf: { name: row.pdf_name, base64: "" } } : {}), ...(row.image_name ? { image: { name: row.image_name, base64: "" } } : {}),
        ...(row.source_ref ? { source: row.source_ref } : {}) },
        ...(row.extract_status !== undefined ? { extract_status: row.extract_status } : {}) } as unknown as Row));
}
export const captureService = createCaptureService({
    get: getCapture,
    async insert(value) {
        const { error } = await db.from("capture_inbox").upsert({ id: value.id, profile_id: value.profileId, source: value.source, source_hash: value.sourceHash }, { onConflict: "profile_id,id", ignoreDuplicates: true })
            .abortSignal(AbortSignal.timeout(15_000));
        if (error) throw new CaptureError("The capture could not be saved. Keep your draft and retry.", 503);
        const saved = await getCapture(value.profileId, value.id);
        if (!saved) throw new CaptureError("The capture was not confirmed. Keep your draft and retry.", 503);
        return saved;
    },
    async receipt(profile, id, receipt) {
        const { error } = await db.from("capture_inbox").update({ receipt }).eq("profile_id", profile).eq("id", id).abortSignal(AbortSignal.timeout(10_000));
        if (error) throw new Error("Inbox receipt failed.");
    },
    async claim(profile, id, claim) {
        const { data, error } = await db.rpc("assistant_capture_claim", { p_profile_id: profile, p_id: id, p_claim: claim }).abortSignal(AbortSignal.timeout(10_000));
        if (error || !data) throw new CaptureError("The reviewed destination could not be reserved. No source write was started; retry later.", 503);
        return data as { path: string; contentHash: string };
    },
    head: () => getBranchHead(requireVaultConfig(), AbortSignal.timeout(15_000)),
    read: async (path, head) => (await getFile(requireVaultConfig(), path, head, AbortSignal.timeout(15_000), true))?.text ?? null,
    commit: (changes, head) => commitFiles(requireVaultConfig(), changes, "capture: add reviewed source", head),
    async index(path, title, markdown, profileId) {
        const profile = await captureProfile();
        if (profile.id !== profileId) throw new Error("The profile changed.");
        const embRef = await vaultEmbeddingRef();
        if (profile.preferences?.freeOnly === true) assertFreeModel(embRef);
        if (!await indexKnowledgeDocument({ path, title, markdown, category: "captures", summary: "", embRef })) throw new Error("Knowledge indexing schema is unavailable.");
    },
    async indexPhoto(photo, profileId) {
        const profile = await captureProfile();
        if (profile.id !== profileId) throw new Error("The profile changed.");
        const embRef = await vaultEmbeddingRef();
        if (profile.preferences?.freeOnly === true) assertFreeModel(embRef);
        const { indexPhotoDocument } = await import("@/lib/knowledge/photos");
        const bytes = Buffer.from(photo.base64, "base64");
        if (!await indexPhotoDocument({ path: photo.path, title: photo.title, text: photo.text, bytes, sourcePath: photo.notePath }, embRef)) throw new Error("Knowledge indexing schema is unavailable.");
    },
    async saveExtract(profile, id, extract) {
        const { error } = await db.from("capture_inbox").update({ extract }).eq("profile_id", profile).eq("id", id).is("receipt", null).abortSignal(AbortSignal.timeout(10_000));
        if (error) throw new CaptureError(missingExtractColumn(error) ? "Source text needs the v7-capture-extract.sql migration." : "The source text could not be saved. Try again.", 503);
    },
    extractor: {
        async read(source, profileId) {
            const extract = await import("./extract");
            if (source.kind !== "image") return extract.extractCapture(source);
            const profile = await captureProfile();
            if (profile.id !== profileId) throw new CaptureError("The account changed. Reopen the inbox.", 409);
            const { readPageImageRecorded } = await import("./extract/page-image");
            return extract.extractCapture(source, { freeOnly: effectiveFreeOnly(profile), readImage: readPageImageRecorded });
        },
        async ocr(source, stored, tier, profileId) {
            const profile = await captureProfile();
            if (profile.id !== profileId) throw new CaptureError("The account changed. Reopen the inbox.", 409);
            return (await import("./extract")).ocrCapture(source, stored, tier, { freeOnly: effectiveFreeOnly(profile) });
        },
        async ocrTiers(profileId) {
            const profile = await captureProfile();
            return profile.id === profileId ? ocrTiers(effectiveFreeOnly(profile)) : { free: false, paid: false };
        },
        acquire: acquireSlot,
    },
});
