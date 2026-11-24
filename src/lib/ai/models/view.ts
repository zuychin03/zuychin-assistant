import { getModelMeta, type ModelMeta } from "@/lib/ai/model-meta";
import type { ChatModel } from "@/lib/ai/providers";
import type { CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { gateTags, tagsFromMeta, type PurposeTag, type TagsSource } from "@/lib/ai/models/tags";
import { modelSpeed, SPEED_WINDOW_DAYS, statsKey, type ModelSpeed, type SpeedStats } from "@/lib/ai/models/stats";
import type { ProfileRecord, ProfileSource } from "@/lib/ai/models/profiles";

// Shared by providers.ts and the roster, so it must not import providers.ts at runtime.

export function capsOf(model: ChatModel) {
    return { supportsTools: model.supportsTools, supportsVision: model.supportsVision };
}

/** Approved or seeded tags from the profile row, else tags read off the hand-written meta. */
export function resolveTags(model: ChatModel, profile: ProfileRecord | undefined, row: CatalogueRow | undefined): { tags: PurposeTag[]; source: TagsSource } {
    // A lookup creates an empty row with the default source; only seeded or chosen tags replace the derived ones.
    if (profile && (profile.tags.length || profile.tagsSource !== "seed")) return { tags: gateTags(profile.tags, capsOf(model)), source: profile.tagsSource };
    return { tags: tagsFromMeta(getModelMeta(model.id), capsOf(model), row?.contextTokens ?? null), source: "derived" };
}

export function resolveSpeed(providerId: string, model: ChatModel, speed: ReadonlyMap<string, SpeedStats>): ModelSpeed {
    return modelSpeed(speed.get(statsKey(providerId, model.id)), model.catalogue?.probeChatMs ?? null);
}

export function auDate(value: string): string {
    return new Date(value).toLocaleDateString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "numeric" });
}

export function seconds(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Facts from probes and recorded calls, recomputed on every read so they never go stale after approval. */
export function measuredFacts(model: ChatModel, row: CatalogueRow | undefined, speed: ModelSpeed): string[] {
    const facts: string[] = [];
    if (row?.missingSince) facts.push(`Missing from the provider's model list since ${auDate(row.missingSince)}`);
    if (model.catalogue?.status === "failing") facts.push(row?.probedAt ? `Failed its last test on ${auDate(row.probedAt)}` : "Failed its last test");
    if (row?.probedAt && row.supportsTools === false) facts.push("Tool calls failed in testing");
    else if (model.supportsTools && !model.supportsSearch) facts.push("Forced tool calls (explicit Search) do not work on this route");
    if (row?.probedAt && row.supportsVision === false && row.inputs.some((input) => input.toLowerCase() === "image")) facts.push("Lists image input but failed the image test");
    if (row?.traits?.video === true) facts.push(row.traits.videoSpeech ? "Reads video and hears its speech in testing" : "Reads video in testing, but not its speech");
    else if (row?.traits?.video === false && row.inputs.some((input) => input.toLowerCase() === "video")) facts.push("Lists video input but failed the video test");
    if (speed.tier === "slow" && speed.firstAnswerMs !== null) {
        facts.push(speed.source === "calls"
            ? `Slow first answer: median ${seconds(speed.firstAnswerMs)} over ${speed.samples} calls in ${SPEED_WINDOW_DAYS} days`
            : `Slow first answer in its last test (${seconds(speed.firstAnswerMs)})`);
    }
    if (speed.reliable === false && speed.successRate !== null) {
        facts.push(`Only ${Math.round(speed.successRate * 100)}% of ${speed.calls} calls succeeded in ${SPEED_WINDOW_DAYS} days`);
    }
    return facts;
}

export interface ModelView extends ModelMeta {
    weaknesses: string[];
    measured: string[];
    sources: ProfileSource[];
    /** Where the description came from. */
    origin: "profile" | "meta" | "listing";
    profileApprovedAt: string | null;
}

function tokenLabel(tokens: number | null): string | undefined {
    if (!tokens) return undefined;
    return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M`.replace(".0M", "M") : `${Math.round(tokens / 1000)}K`;
}

/** Info modal content: an approved profile, then the hand-written meta, then the provider's listing. */
export function modelView(model: ChatModel, profile: ProfileRecord | undefined, row: CatalogueRow | undefined, speed: ModelSpeed): ModelView | null {
    const meta = getModelMeta(model.id);
    const measured = measuredFacts(model, row, speed);
    const approved = profile?.profile && profile.approvedAt ? profile.profile : null;
    const listingInputs = row?.inputs.map((input) => input.charAt(0).toUpperCase() + input.slice(1)) ?? [];
    const base = {
        inputs: meta?.inputs ?? listingInputs,
        context: meta?.context ?? tokenLabel(row?.contextTokens ?? null),
        maxOutput: meta?.maxOutput ?? tokenLabel(row?.maxOutputTokens ?? null),
    };
    if (approved) {
        return {
            ...base, developer: approved.developer ?? meta?.developer ?? row?.developer ?? "", description: approved.description,
            params: approved.params ?? meta?.params, strengths: approved.strengths, weaknesses: approved.weaknesses,
            measured, sources: approved.sources, origin: "profile", profileApprovedAt: profile!.approvedAt,
        };
    }
    if (meta) return { ...meta, ...base, weaknesses: [], measured, sources: [], origin: "meta", profileApprovedAt: null };
    if (row?.description || measured.length) {
        return { ...base, developer: row?.developer ?? "", description: row?.description ?? "", strengths: [], weaknesses: [], measured, sources: [], origin: "listing", profileApprovedAt: null };
    }
    return null;
}
