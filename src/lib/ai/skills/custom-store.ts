import { supabaseAdmin as supabase } from "@/lib/supabase";
import { SKILL_IDS } from "@/lib/ai/skills/registry";

export interface CustomSkill {
    id: string;
    slug: string;
    name: string;
    whenToUse: string;
    instructions: string;
    status: "draft" | "active";
    createdBy: "agent" | "user";
    createdAt: string;
    updatedAt: string;
}

function mapSkill(row: Record<string, unknown>): CustomSkill {
    return {
        id: row.id as string,
        slug: row.slug as string,
        name: row.name as string,
        whenToUse: row.when_to_use as string,
        instructions: row.instructions as string,
        status: row.status as CustomSkill["status"],
        createdBy: row.created_by as CustomSkill["createdBy"],
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    };
}

// Active skills join the agent's skill index on every run; cache so a run's
// prompt build + use_skill lookups cost at most one DB read per minute.
const CACHE_TTL_MS = 60_000;
let cachedActive: CustomSkill[] | null = null;
let cachedAt = 0;

export function invalidateSkillCache(): void {
    cachedActive = null;
    cachedAt = 0;
}

export async function getActiveCustomSkills(): Promise<CustomSkill[]> {
    if (cachedActive && Date.now() - cachedAt < CACHE_TTL_MS) return cachedActive;
    try {
        const { data, error } = await supabase
            .from("custom_skills")
            .select("*")
            .eq("status", "active")
            .order("created_at", { ascending: true });
        if (error) throw error;
        cachedActive = (data ?? []).map(mapSkill);
        cachedAt = Date.now();
        return cachedActive;
    } catch (err) {
        console.warn("[Skills] Failed to load custom skills, using static only:", err instanceof Error ? err.message : err);
        return cachedActive ?? [];
    }
}

export async function listCustomSkills(): Promise<CustomSkill[]> {
    const { data, error } = await supabase
        .from("custom_skills")
        .select("*")
        .order("created_at", { ascending: false });
    if (error) {
        console.warn("[Skills] Failed to list custom skills:", error.message);
        return [];
    }
    return (data ?? []).map(mapSkill);
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function createDraftSkill(params: {
    slug: string;
    name: string;
    whenToUse: string;
    instructions: string;
    createdBy?: "agent" | "user";
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const slug = params.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug) || slug.length > 60) {
        return { ok: false, reason: `Invalid slug "${params.slug}" — use short kebab-case (e.g. "summarize-invoices").` };
    }
    if (SKILL_IDS.includes(slug)) {
        return { ok: false, reason: `Slug "${slug}" collides with a built-in skill. Pick a different slug.` };
    }
    if (!params.name.trim() || !params.whenToUse.trim() || !params.instructions.trim()) {
        return { ok: false, reason: "name, when_to_use and instructions are all required." };
    }

    const { data, error } = await supabase
        .from("custom_skills")
        .insert({
            slug,
            name: params.name.trim(),
            when_to_use: params.whenToUse.trim(),
            instructions: params.instructions.trim(),
            created_by: params.createdBy ?? "agent",
        })
        .select("id")
        .single();

    if (error) {
        if (error.code === "23505") {
            return { ok: false, reason: `A custom skill with slug "${slug}" already exists. Update it instead or pick a new slug.` };
        }
        console.warn("[Skills] Failed to create draft:", error.message);
        return { ok: false, reason: "Database error saving the skill draft." };
    }
    return { ok: true, id: data.id as string };
}

export async function updateCustomSkill(params: {
    id: string;
    name?: string;
    whenToUse?: string;
    instructions?: string;
    status?: "draft" | "active";
}): Promise<boolean> {
    const patch: Record<string, string> = {};
    if (params.name !== undefined) patch.name = params.name.trim();
    if (params.whenToUse !== undefined) patch.when_to_use = params.whenToUse.trim();
    if (params.instructions !== undefined) patch.instructions = params.instructions.trim();
    if (params.status !== undefined) patch.status = params.status;
    if (Object.keys(patch).length === 0) return true;

    const { error } = await supabase.from("custom_skills").update(patch).eq("id", params.id);
    if (error) {
        console.warn("[Skills] Failed to update custom skill:", error.message);
        return false;
    }
    invalidateSkillCache();
    return true;
}

export async function deleteCustomSkill(id: string): Promise<boolean> {
    const { error } = await supabase.from("custom_skills").delete().eq("id", id);
    if (error) {
        console.warn("[Skills] Failed to delete custom skill:", error.message);
        return false;
    }
    invalidateSkillCache();
    return true;
}
