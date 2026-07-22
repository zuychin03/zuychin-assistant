// Discord is now a multi-channel life-ops dashboard: one channel per
// notification purpose. Each purpose reads its own env var and falls back to
// DISCORD_CHANNEL_ID (the legacy single channel) so nothing breaks before the
// dedicated channels are created.

export type DiscordPurpose =
    | "ask"
    | "briefing"
    | "reminders"
    | "tasks"
    | "calendar"
    | "bills"
    | "coworking"
    | "system";

const FALLBACK = process.env.DISCORD_CHANNEL_ID || undefined;

const ENV_MAP: Record<DiscordPurpose, string | undefined> = {
    ask: process.env.DISCORD_ASK_CHANNEL_ID,
    briefing: process.env.DISCORD_CH_BRIEFING,
    reminders: process.env.DISCORD_CH_REMINDERS,
    tasks: process.env.DISCORD_CH_TASKS,
    calendar: process.env.DISCORD_CH_CALENDAR,
    bills: process.env.DISCORD_CH_BILLS,
    coworking: process.env.DISCORD_CH_COWORKING,
    system: process.env.DISCORD_CH_SYSTEM,
};

// allowFallback=false keeps a purpose silent until its channel is explicitly
// set (used for opt-in channels like #system that should not spam the fallback).
export function discordChannel(purpose: DiscordPurpose, allowFallback = true): string | undefined {
    return ENV_MAP[purpose] ?? (allowFallback ? FALLBACK : undefined);
}

export function hasAnyDiscordChannel(): boolean {
    return !!FALLBACK || Object.values(ENV_MAP).some(Boolean);
}
