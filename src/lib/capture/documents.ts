import { supabaseAdmin as db } from "@/lib/supabase";
import { CaptureError } from "./service";

export async function captureDocuments(profileId: string) {
    const [{ data: projects, error: projectError }, { data: documents, error }] = await Promise.all([
        db.from("projects").select("id").eq("user_profile_id", profileId).abortSignal(AbortSignal.timeout(5000)),
        db.from("knowledge_documents").select("id,path,title,project_id,user_profile_id,scope,status").eq("status", "active").order("title").limit(1001).abortSignal(AbortSignal.timeout(5000)),
    ]);
    if (error || projectError) throw new CaptureError("Your permitted source list is unavailable. Retry before downloading.", 503);
    if ((documents?.length ?? 0) > 1000) throw new CaptureError("The source list exceeds 1,000 documents. Narrow the library before downloading.", 413);
    const owned = new Set((projects ?? []).map(project => project.id));
    return (documents ?? []).filter(document => (!document.user_profile_id || document.user_profile_id === profileId)
        && (document.project_id ? owned.has(document.project_id) : ["user", "repository"].includes(document.scope)))
        .map(({ id, path, title }) => ({ id: String(id), path: String(path), title: String(title) }));
}
