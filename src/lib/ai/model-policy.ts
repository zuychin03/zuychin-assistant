import { PROVIDERS, isProviderAvailable, resolveChat, type ResolvedChat, type ResolvedEmbedding } from "@/lib/ai/providers";

export class ModelPolicyError extends Error {}

export function effectiveFreeOnly(profile: { preferences?: unknown } | null, requested = false, paidOnly = false): boolean {
    if (paidOnly) return false;
    if (!profile) throw new ModelPolicyError("Chat preferences are unavailable. Please try again before generating a reply.");
    return requested === true || (profile.preferences as { freeOnly?: unknown } | null)?.freeOnly === true;
}

export function assertFreeModel(ref: ResolvedChat | ResolvedEmbedding): void {
    if (ref.model.free !== true || !isProviderAvailable(ref.provider)) {
        throw new ModelPolicyError(`Free only cannot use ${ref.model.label} (${ref.provider.label}). Select an available free route; embedding partitions must be migrated separately.`);
    }
}

export function freeChatCandidates(geminiOnly = false): ResolvedChat[] {
    return PROVIDERS.flatMap((provider) => {
        if (!isProviderAvailable(provider) || (geminiOnly && provider.kind !== "gemini")) return [];
        return provider.chatModels.flatMap((model) => {
            if (model.free !== true) return [];
            try { return [resolveChat(provider.id, model.id)]; } catch { return []; }
        });
    });
}

export function resolveFreeChat(preferred?: ResolvedChat | null, geminiOnly = false): ResolvedChat {
    if (preferred?.model.free === true && isProviderAvailable(preferred.provider)
        && (!geminiOnly || preferred.provider.kind === "gemini")) return preferred;
    const chosen = freeChatCandidates(geminiOnly)[0];
    if (!chosen) throw new ModelPolicyError(`Free only has no available ${geminiOnly ? "Gemini " : ""}route. Configure a free provider key or turn Free only off.`);
    return chosen;
}

const FREE_TOOLS = new Set([
    "get_current_time", "search_knowledge", "search_history", "save_note", "get_recent_conversations",
    "list_calendar_events", "manage_calendar_event", "list_unread_emails", "list_recent_emails", "read_email",
    "draft_gmail_reply", "send_email", "vault_read", "manage_todo_list", "manage_scheduled_task",
]);

export function freeToolRefusal(name: string, freeOnly?: boolean): string | null {
    return freeOnly && !FREE_TOOLS.has(name)
        ? `Free only: ${name} is unavailable because its helper or indexing route is not yet covered by the free model policy. No tool action was performed.`
        : null;
}
