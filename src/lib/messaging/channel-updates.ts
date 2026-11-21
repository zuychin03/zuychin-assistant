import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";

export type UpdateClaim = "new" | "seen" | "unrecorded";
type UpdateChannel = "telegram" | "discord";

const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

let lastPrune = 0;
let warnedMissing = false;

// Telegram re-sends an update it saw no 200 for, so a turn must run once per
// update_id. Without the table (v7-channel-threads.sql not applied) updates
// still run, just without the guard.
export async function claimChannelUpdate(channel: UpdateChannel, key: string, client: SupabaseClient = supabaseAdmin): Promise<UpdateClaim> {
    const { data, error } = await client
        .from("assistant_channel_updates")
        .upsert({ channel, update_key: key }, { onConflict: "channel,update_key", ignoreDuplicates: true })
        .select("update_key");
    if (error) {
        if (!MISSING_TABLE.has((error as { code?: string }).code ?? "")) console.warn(`[${channel}] Update dedupe unavailable:`, error.message);
        else if (!warnedMissing) {
            warnedMissing = true;
            console.warn(`[${channel}] assistant_channel_updates is missing; apply scripts/migrations/v7-channel-threads.sql. Updates run without dedupe.`);
        }
        return "unrecorded";
    }
    if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        void client.from("assistant_channel_updates").delete().eq("channel", channel)
            .lt("received_at", new Date(Date.now() - RETAIN_MS).toISOString())
            .then(({ error: pruneError }) => { if (pruneError) console.warn(`[${channel}] Update prune failed:`, pruneError.message); });
    }
    return data && data.length > 0 ? "new" : "seen";
}
