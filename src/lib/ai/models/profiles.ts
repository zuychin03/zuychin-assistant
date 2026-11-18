import { isPurposeTag, PURPOSE_TAGS, type PurposeTag } from "@/lib/ai/models/tags";

export const PROFILE_LIMITS = { description: 300, item: 80, items: 6, sources: 8, sourceTitle: 120, developer: 100, params: 100, reason: 160 } as const;

export interface ProfileSource {
    title: string;
    url: string;
}

export interface ModelProfile {
    description: string;
    developer: string | null;
    params: string | null;
    strengths: string[];
    weaknesses: string[];
    sources: ProfileSource[];
}

export interface ProfileDraft extends ModelProfile {
    suggestedTags: PurposeTag[];
    tagReasons: Partial<Record<PurposeTag, string>>;
    /** "sibling" copies an approved profile of the same model on another provider. */
    basis: "lookup" | "sibling";
    siblingOf: string | null;
    sourcesTried: { name: string; ok: boolean }[];
}

export type DraftStatus = "none" | "pending" | "ready" | "failed";
export type StoredTagsSource = "seed" | "lookup" | "owner";

export interface ProfileRecord {
    providerId: string;
    modelId: string;
    tags: PurposeTag[];
    tagsSource: StoredTagsSource;
    profile: ModelProfile | null;
    approvedAt: string | null;
    draft: ProfileDraft | null;
    draftStatus: DraftStatus;
    draftError: string | null;
    draftedAt: string | null;
    lookupAttempts: number;
    vaultPath: string | null;
    vaultSyncedAt: string | null;
    vaultError: string | null;
}

export const PROFILE_COLUMNS = [
    "provider_id", "model_id", "tags", "tags_source", "profile", "approved_at", "draft", "draft_status", "draft_error",
    "drafted_at", "lookup_attempts", "vault_path", "vault_synced_at", "vault_error",
].join(", ");

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/;
const DRAFT_STATUSES: readonly DraftStatus[] = ["none", "pending", "ready", "failed"];

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const stamp = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

/** One line of plain text: control characters and runs of whitespace collapse, then the length is capped. */
export function cleanLine(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!line) return null;
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function cleanList(value: unknown, max = PROFILE_LIMITS.items): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
        const line = cleanLine(entry, PROFILE_LIMITS.item);
        if (line && !out.some((existing) => existing.toLowerCase() === line.toLowerCase())) out.push(line);
        if (out.length >= max) break;
    }
    return out;
}

export function safeUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 500) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

function cleanSources(value: unknown, allowed?: ReadonlySet<string>): ProfileSource[] {
    if (!Array.isArray(value)) return [];
    const out: ProfileSource[] = [];
    for (const entry of value) {
        const source = record(entry);
        const url = safeUrl(source.url);
        if (!url || (allowed && !allowed.has(url)) || out.some((existing) => existing.url === url)) continue;
        out.push({ url, title: cleanLine(source.title, PROFILE_LIMITS.sourceTitle) ?? new URL(url).hostname });
        if (out.length >= PROFILE_LIMITS.sources) break;
    }
    return out;
}

/** A profile from untrusted JSON with every field capped. `allowedUrls` limits sources to pages the lookup fetched. */
export function profileFromJson(raw: unknown, allowedUrls?: ReadonlySet<string>): ModelProfile | null {
    const value = record(raw);
    const description = cleanLine(value.description, PROFILE_LIMITS.description);
    if (!description) return null;
    return {
        description,
        developer: cleanLine(value.developer, PROFILE_LIMITS.developer),
        params: cleanLine(value.params, PROFILE_LIMITS.params),
        strengths: cleanList(value.strengths),
        weaknesses: cleanList(value.weaknesses),
        sources: cleanSources(value.sources, allowedUrls),
    };
}

export function draftFromJson(raw: unknown): ProfileDraft | null {
    const value = record(raw);
    const profile = profileFromJson(value);
    if (!profile) return null;
    const reasons = record(value.tagReasons);
    const tagReasons: Partial<Record<PurposeTag, string>> = {};
    for (const tag of PURPOSE_TAGS) {
        const reason = cleanLine(reasons[tag], PROFILE_LIMITS.reason);
        if (reason) tagReasons[tag] = reason;
    }
    const tried = Array.isArray(value.sourcesTried) ? value.sourcesTried : [];
    return {
        ...profile,
        suggestedTags: PURPOSE_TAGS.filter((tag) => Array.isArray(value.suggestedTags) && value.suggestedTags.includes(tag)),
        tagReasons,
        basis: value.basis === "sibling" ? "sibling" : "lookup",
        siblingOf: cleanLine(value.siblingOf, 300),
        sourcesTried: tried.flatMap((entry) => {
            const item = record(entry);
            const name = cleanLine(item.name, 60);
            return name ? [{ name, ok: item.ok === true }] : [];
        }).slice(0, 10),
    };
}

export function profileRecordFromDb(raw: unknown): ProfileRecord | null {
    const row = record(raw);
    const providerId = row.provider_id, modelId = row.model_id;
    if (typeof providerId !== "string" || !ID.test(providerId) || typeof modelId !== "string" || !ID.test(modelId)) return null;
    const tagsSource = row.tags_source === "lookup" || row.tags_source === "owner" ? row.tags_source : "seed";
    return {
        providerId, modelId,
        tags: PURPOSE_TAGS.filter((tag) => Array.isArray(row.tags) && row.tags.includes(tag)),
        tagsSource,
        profile: row.profile ? profileFromJson(row.profile) : null,
        approvedAt: stamp(row.approved_at),
        draft: row.draft ? draftFromJson(row.draft) : null,
        draftStatus: DRAFT_STATUSES.includes(row.draft_status as DraftStatus) ? row.draft_status as DraftStatus : "none",
        draftError: cleanLine(row.draft_error, 500),
        draftedAt: stamp(row.drafted_at),
        lookupAttempts: typeof row.lookup_attempts === "number" && Number.isSafeInteger(row.lookup_attempts) && row.lookup_attempts > 0 ? row.lookup_attempts : 0,
        vaultPath: cleanLine(row.vault_path, 300),
        vaultSyncedAt: stamp(row.vault_synced_at),
        vaultError: cleanLine(row.vault_error, 500),
    };
}

/** The same model on another provider shares this key: the id without vendor prefix and free suffix. */
export function familyKey(modelId: string): string {
    return modelId.slice(modelId.lastIndexOf("/") + 1).replace(/:free$/, "").replace(/-free$/, "").toLowerCase();
}

export function parseTagList(raw: unknown): PurposeTag[] | null {
    if (!Array.isArray(raw) || raw.length > PURPOSE_TAGS.length || !raw.every(isPurposeTag)) return null;
    return PURPOSE_TAGS.filter((tag) => raw.includes(tag));
}
