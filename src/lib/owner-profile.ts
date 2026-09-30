import { supabaseAdmin } from "@/lib/supabase";

export interface OwnerProfile {
    id: string;
    displayName: string;
    systemPrompt: string | null;
    preferences: Record<string, unknown> | null;
}

export class OwnerProfileError extends Error {}

interface ProfileRow {
    id: string;
    display_name: string;
    system_prompt: string | null;
    preferences: Record<string, unknown> | null;
}

const COLUMNS = "id, display_name, system_prompt, preferences";
let warnedDuplicates = false;

function toOwner(row: ProfileRow): OwnerProfile {
    return { id: row.id, displayName: row.display_name, systemPrompt: row.system_prompt, preferences: row.preferences };
}

/** The install's single owner profile, or null before setup has seeded one. */
export async function resolveOwnerProfile(signal?: AbortSignal): Promise<OwnerProfile | null> {
    let query = supabaseAdmin.from("user_profiles").select(COLUMNS)
        .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(2);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    // maybeSingle reports a second row as PGRST116.
    if (error?.code === "PGRST116") return resolveDuplicateOwner(signal);
    if (error) throw new OwnerProfileError(error.message);
    return data ? toOwner(data as ProfileRow) : null;
}

// Setup re-runs used to seed a profile each time. Until owner-profile-consolidation.sql
// merges them, keep the profile holding the newest message, the same choice the script makes.
async function resolveDuplicateOwner(signal?: AbortSignal): Promise<OwnerProfile> {
    if (!warnedDuplicates) {
        warnedDuplicates = true;
        console.warn("[Profile] Several user profiles exist; using the one with the newest message. Run scripts/migrations/owner-profile-consolidation.sql.");
    }
    let newest = supabaseAdmin.from("messages").select("user_profile_id").not("user_profile_id", "is", null)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
    if (signal) newest = newest.abortSignal(signal);
    const latest = await newest.maybeSingle();
    if (latest.error) throw new OwnerProfileError(latest.error.message);
    let query = supabaseAdmin.from("user_profiles").select(COLUMNS);
    query = latest.data
        ? query.eq("id", latest.data.user_profile_id)
        : query.order("created_at", { ascending: true }).order("id", { ascending: true });
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.limit(1).maybeSingle();
    if (error) throw new OwnerProfileError(error.message);
    if (!data) throw new OwnerProfileError("The owner profile could not be found.");
    return toOwner(data as ProfileRow);
}
