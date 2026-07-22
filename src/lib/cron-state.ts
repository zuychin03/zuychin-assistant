import { supabaseAdmin as supabase } from "@/lib/supabase";

// Shared k/v state for crons (high-water marks etc.). Deliberately not the
// user_profiles.preferences bag: that object is replaced whole on write, so
// concurrent cron writers would clobber user settings.

export async function getCronState<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    const { data, error } = await supabase
        .from("cron_state")
        .select("value")
        .eq("key", key)
        .maybeSingle();

    if (error) throw new Error(`cron_state unreadable: ${error.message}`);
    return (data?.value as T) ?? null;
}

export async function setCronState(key: string, value: Record<string, unknown>): Promise<void> {
    const { error } = await supabase
        .from("cron_state")
        .upsert({ key, value }, { onConflict: "key" });

    if (error) throw new Error(`cron_state unwritable: ${error.message}`);
}

export async function listCronStateByPrefix<T>(prefix: string): Promise<{ key: string; value: T }[]> {
    const { data, error } = await supabase
        .from("cron_state")
        .select("key, value")
        .like("key", `${prefix}%`);

    if (error) throw new Error(`cron_state unreadable: ${error.message}`);
    return (data ?? []).map((r) => ({ key: r.key as string, value: r.value as T }));
}

export async function deleteCronState(key: string): Promise<void> {
    const { error } = await supabase.from("cron_state").delete().eq("key", key);
    if (error) throw new Error(`cron_state undeletable: ${error.message}`);
}
