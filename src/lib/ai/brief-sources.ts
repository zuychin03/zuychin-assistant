import { listDueTodos, listTodos } from "@/lib/db";
import { listUpcomingEvents } from "@/lib/integrations/calendar-service";
import { listCaptures } from "@/lib/capture/store";
import { knowledgeRevisions } from "@/lib/knowledge/revision-store";
import { resolveOwnerProfile } from "@/lib/owner-profile";
import { createStudyService } from "@/lib/study/service";
import { supabaseAdmin } from "@/lib/supabase";
import type { BriefSources } from "@/lib/ai/brief";

/** The same reads as the Today panel (`/api/today`), the Capture inbox and Study's due count. */
export function liveBriefSources(): BriefSources {
    let owner: Promise<string> | null = null;
    const ownerId = () => owner ??= resolveOwnerProfile(AbortSignal.timeout(10_000)).then((profile) => {
        if (!profile) throw new Error("The owner profile is unavailable.");
        return profile.id;
    });
    return {
        events: () => listUpcomingEvents(24, 10),
        dueTodos: () => listDueTodos(24, null),
        openTodos: () => listTodos("pending", 10),
        captures: async () => (await listCaptures(await ownerId())).map((item) => ({ title: item.source.title || "Untitled capture", createdAt: item.createdAt, saved: !!item.receipt })),
        studyDue: async () => (await createStudyService(supabaseAdmin, knowledgeRevisions).due(await ownerId())).due,
        studyCards: async () => {
            const { data, error } = await supabaseAdmin.from("study_cards").select("deck,prompt").eq("user_profile_id", await ownerId()).eq("active", true)
                .lte("due_at", new Date().toISOString()).order("due_at", { ascending: true }).limit(30).abortSignal(AbortSignal.timeout(5000));
            if (error) throw new Error("Study cards are unavailable.");
            return (data ?? []).map((row) => ({ deck: String(row.deck), prompt: String(row.prompt) }));
        },
    };
}
