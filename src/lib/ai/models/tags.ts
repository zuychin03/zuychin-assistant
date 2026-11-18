import type { ModelMeta } from "@/lib/ai/model-meta";

// Mirrors the check constraint on model_profiles.tags in v7-model-awareness.sql.
export const PURPOSE_TAGS = ["research", "coding", "reasoning", "writing", "vision", "long-context", "multilingual", "agentic"] as const;
export type PurposeTag = typeof PURPOSE_TAGS[number];
export type TagsSource = "seed" | "lookup" | "owner" | "derived";

export interface TagInfo {
    label: string;
    meaning: string;
    requires?: "tools" | "vision";
}

export const TAG_INFO: Record<PurposeTag, TagInfo> = {
    research: { label: "Research", meaning: "Web research and synthesis across sources", requires: "tools" },
    coding: { label: "Coding", meaning: "Writing, reviewing and debugging code" },
    reasoning: { label: "Reasoning", meaning: "Multi-step analysis, maths and planning" },
    writing: { label: "Writing", meaning: "Drafting, rewriting and summarising prose" },
    vision: { label: "Vision", meaning: "Images, screenshots and scanned pages", requires: "vision" },
    "long-context": { label: "Long context", meaning: "Very long inputs, about 500K tokens or more" },
    multilingual: { label: "Multilingual", meaning: "Languages other than English, Vietnamese included" },
    agentic: { label: "Agentic", meaning: "Reliable multi-step tool use", requires: "tools" },
};

export const LONG_CONTEXT_TOKENS = 500_000;

export interface TagCapabilities {
    supportsTools: boolean;
    supportsVision: boolean;
}

export function isPurposeTag(value: unknown): value is PurposeTag {
    return typeof value === "string" && (PURPOSE_TAGS as readonly string[]).includes(value);
}

/** Why a model cannot carry this tag, or null when it can. */
export function tagBlockedReason(tag: PurposeTag, caps: TagCapabilities): string | null {
    const requires = TAG_INFO[tag].requires;
    if (requires === "tools" && !caps.supportsTools) return "Needs tool calls, which this model does not support";
    if (requires === "vision" && !caps.supportsVision) return "Needs image input, which this model does not support";
    return null;
}

/** Known tags only, in canonical order, without the ones the model's capabilities rule out. */
export function gateTags(raw: unknown, caps: TagCapabilities): PurposeTag[] {
    const wanted = new Set(Array.isArray(raw) ? raw.filter(isPurposeTag) : []);
    return PURPOSE_TAGS.filter((tag) => wanted.has(tag) && tagBlockedReason(tag, caps) === null);
}

const STRENGTH_TAGS: Record<string, PurposeTag[]> = {
    Coding: ["coding"], Code: ["coding"], Reasoning: ["reasoning"], Math: ["reasoning"],
    Agentic: ["agentic"], "Tool use": ["agentic"], Vision: ["vision"], Multimodal: ["vision"],
    Multilingual: ["multilingual"], "Long context": ["long-context"],
};

/** Fallback when no profile row exists: tags read off the hand-written strengths and context size. */
export function tagsFromMeta(meta: ModelMeta | null, caps: TagCapabilities, contextTokens: number | null = null): PurposeTag[] {
    const tags: PurposeTag[] = [];
    for (const strength of meta?.strengths ?? []) tags.push(...(STRENGTH_TAGS[strength] ?? []));
    if (meta?.context === "1M" || (contextTokens !== null && contextTokens >= LONG_CONTEXT_TOKENS)) tags.push("long-context");
    return gateTags(tags, caps);
}
