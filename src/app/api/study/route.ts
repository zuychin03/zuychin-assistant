import { supabaseAdmin } from "@/lib/supabase";
import { knowledgeRevisions } from "@/lib/knowledge/revision-store";
import { resolveOwnerProfile } from "@/lib/owner-profile";
import { createStudyService } from "@/lib/study/service";
import { createStudyHandlers } from "@/lib/study/api";
import { StudyError } from "@/lib/study/contracts";
import { studyWriter } from "@/lib/study/writer";

const handlers = createStudyHandlers(createStudyService(supabaseAdmin, knowledgeRevisions, undefined, studyWriter), async () => {
    const profile = await resolveOwnerProfile(AbortSignal.timeout(5000)).catch(() => null);
    if (!profile) throw new StudyError("Your study profile is unavailable. Please retry.", 503);
    return profile.id;
});
export const GET = handlers.GET;
export const POST = handlers.POST;
