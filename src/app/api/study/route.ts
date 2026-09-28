import { supabaseAdmin } from "@/lib/supabase";
import { knowledgeRevisions } from "@/lib/knowledge/revision-store";
import { createStudyService } from "@/lib/study/service";
import { createStudyHandlers } from "@/lib/study/api";
import { StudyError } from "@/lib/study/contracts";

const handlers = createStudyHandlers(createStudyService(supabaseAdmin, knowledgeRevisions), async () => {
    const { data, error } = await supabaseAdmin.from("user_profiles").select("id").limit(1).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (error || !data) throw new StudyError("Your study profile is unavailable. Please retry.", 503);
    return data.id;
});
export const GET = handlers.GET;
export const POST = handlers.POST;
