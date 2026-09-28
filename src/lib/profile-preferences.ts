import { supabaseAdmin as supabase } from "@/lib/supabase";

export class ProfilePreferencesError extends Error {
    constructor(public readonly reason: "missing" | "unavailable" | "conflict") {
        super(reason === "missing" ? "Profile not found." : "Could not save preferences. Please retry.");
    }
}

export async function patchProfilePreferences(profileId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const { data, error } = await supabase.from("user_profiles").select("preferences").eq("id", profileId).maybeSingle();
        if (error) throw new ProfilePreferencesError("unavailable");
        if (!data) throw new ProfilePreferencesError("missing");
        const current = data.preferences && typeof data.preferences === "object" && !Array.isArray(data.preferences)
            ? data.preferences as Record<string, unknown> : {};
        const preferences = { ...current };
        for (const [key, value] of Object.entries(patch)) {
            const prior = current[key];
            preferences[key] = value && typeof value === "object" && !Array.isArray(value)
                && prior && typeof prior === "object" && !Array.isArray(prior)
                ? { ...prior as Record<string, unknown>, ...value as Record<string, unknown> } : value;
        }
        let update = supabase.from("user_profiles").update({ preferences }).eq("id", profileId);
        update = data.preferences == null ? update.is("preferences", null) : update.eq("preferences", JSON.stringify(data.preferences));
        const { data: saved, error: saveError } = await update.select("preferences").maybeSingle();
        if (saveError) throw new ProfilePreferencesError("unavailable");
        if (saved) return saved.preferences as Record<string, unknown>;
    }
    throw new ProfilePreferencesError("conflict");
}

export const updateProfilePreferences = patchProfilePreferences;
