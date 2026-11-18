import { scoreEntry, type RosterEntry } from "@/lib/ai/models/roster";
import { TAG_INFO, type PurposeTag } from "@/lib/ai/models/tags";
import { seconds } from "@/lib/ai/models/view";

// Text for the /model command in Telegram, Discord and web chat. Plain lines, since both channels split long replies.

export interface ListedGroup {
    provider: string;
    providerId: string;
    models: { id: string; name: string; label: string; status?: "new" | "missing" }[];
}

const speedWord = (entry: RosterEntry | undefined) => entry && entry.speed.tier !== "unknown"
    ? `${entry.speed.tier}${entry.speed.firstAnswerMs !== null ? ` ${seconds(entry.speed.firstAnswerMs)}` : ""}` : null;

export function formatModelListing(groups: readonly ListedGroup[], roster: readonly RosterEntry[]): string {
    const byKey = new Map(roster.map((entry) => [entry.key, entry]));
    return groups.map((group) => `${group.provider} (${group.providerId})\n` + group.models.map((model) => {
        const entry = byKey.get(`${group.providerId}::${model.id}`);
        const extras = [model.status, speedWord(entry), entry?.tags.length ? `good for ${entry.tags.slice(0, 3).join(", ")}` : null].filter(Boolean);
        return `  • ${model.name} - ${model.label}${extras.length ? ` (${extras.join("; ")})` : ""}`;
    }).join("\n")).join("\n");
}

/** `/model <purpose>`: the five best usable models with that tag, and the command to switch to each. */
export function formatPurposePicks(roster: readonly RosterEntry[], purpose: PurposeTag, freeOnly: boolean): string {
    const picks = roster.filter((entry) => entry.hintEligible && entry.tags.includes(purpose) && entry.status !== "failing" && entry.status !== "missing")
        .sort((a, b) => scoreEntry(b, purpose) - scoreEntry(a, purpose) || Number(a.paid) - Number(b.paid) || a.order - b.order || a.label.localeCompare(b.label))
        .slice(0, 5);
    if (!picks.length) return `No ${freeOnly ? "free " : ""}model is tagged for ${purpose} right now. Send /model list to see every model.`;
    return [
        `Best models for ${purpose} (${TAG_INFO[purpose].meaning.toLowerCase()})${freeOnly ? ", free only" : ""}:`,
        ...picks.map((entry, index) => `${index + 1}. ${entry.label}, ${entry.providerLabel}, ${entry.paid ? "paid" : "free"}, ${speedWord(entry) ?? "speed not measured"}. Switch: /model ${entry.providerId} ${entry.name}`),
    ].join("\n");
}
