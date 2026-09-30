import { supabaseAdmin } from "@/lib/supabase";
import { resolveOwnerProfile } from "@/lib/owner-profile";
import { createRevisionService, type RevisionDocument } from "@/lib/knowledge/revisions";
import { indexKnowledgeDocument } from "@/lib/knowledge/store";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import { commitFiles, getBranchHead, getFile, isVaultCommitAncestor, listVaultFileRevisions, requireVaultConfig } from "@/lib/vault/github";

export const knowledgeRevisions = createRevisionService({
    async getDocument(id) {
        const profile = await resolveOwnerProfile(AbortSignal.timeout(5000)).catch(() => null);
        if (!profile) throw new Error("Your knowledge profile is unavailable.");
        const { data, error } = await supabaseAdmin.from("knowledge_documents")
            .select("id,path,title,summary,category,scope,trust,status,sensitivity,project_id,user_profile_id")
            .eq("id", id).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
        if (error) throw new Error("Knowledge metadata is unavailable.");
        if (!data || (data.user_profile_id && data.user_profile_id !== profile.id)) return null;
        if (data.project_id) {
            const { data: project, error: projectError } = await supabaseAdmin.from("projects").select("id")
                .eq("id", data.project_id).eq("user_profile_id", profile.id).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
            if (projectError) throw new Error("Knowledge project access is unavailable.");
            if (!project) return null;
        } else if (!["user", "repository"].includes(data.scope)) return null;
        return data as RevisionDocument | null;
    },
    getHead: () => getBranchHead(requireVaultConfig(), AbortSignal.timeout(15_000)),
    getFile: (path, sha) => getFile(requireVaultConfig(), path, sha, AbortSignal.timeout(15_000), true),
    isAncestor: (sha, head) => isVaultCommitAncestor(requireVaultConfig(), sha, head),
    list: (path, head, page) => listVaultFileRevisions(requireVaultConfig(), path, head, page),
    commit: (changes, expectedHead) => commitFiles(requireVaultConfig(), changes, "restore: previous knowledge content", expectedHead),
    async index(document, markdown) {
        const indexed = await indexKnowledgeDocument({ path: document.path, title: document.title, summary: document.summary,
            category: document.category, markdown, embRef: await vaultEmbeddingRef() });
        if (!indexed) throw new Error("Knowledge indexing requires the current schema.");
    },
    async recordEvent(event) {
        const { error } = await supabaseAdmin.from("knowledge_events").insert({ document_id: event.documentId,
            action: "restored", actor: "user", detail: { ...event, restoreType: "historical_content" } })
            .abortSignal(AbortSignal.timeout(10_000));
        if (error) throw new Error("The revision event could not be recorded.");
    },
});
