import type { SupabaseClient } from "@supabase/supabase-js";
import type { knowledgeRevisions } from "../knowledge/revision-store";
import { assertEvidenceMatchesSource, documentInResearchScope, editSourceSchema, parseResearchEntry, questionSchema, ResearchError,
    sourceSchema, type ResearchDocument, type ResearchEntry, type ResearchQuestion, type ResearchSource, type ResearchWorkspace } from "./contracts";

type RevisionReader = Pick<typeof knowledgeRevisions, "list" | "snapshot" | "evidence">;
type Row = Record<string, unknown>;
function question(row: Row): ResearchQuestion {
    return { id: row.id as string, projectId: row.project_id as string, title: row.title as string, question: row.question as string,
        status: row.status as ResearchQuestion["status"], version: Number(row.version), updatedAt: row.updated_at as string };
}
function source(row: Row): ResearchSource {
    return { id: row.id as string, questionId: row.question_id as string, documentId: row.document_id as string, path: row.path as string,
        commitSha: row.commit_sha as string, contentHash: row.content_hash as string, title: row.title as string, version: Number(row.version), removedAt: (row.removed_at as string | null) ?? null };
}
function entry(row: Row): ResearchEntry {
    return { id: row.id as string, questionId: row.question_id as string, sourceId: (row.source_id as string | null) ?? null,
        kind: row.kind as ResearchEntry["kind"], text: row.text as string, evidence: (row.evidence as ResearchEntry["evidence"]) ?? null,
        version: Number(row.version), updatedAt: row.updated_at as string };
}
function databaseError(error: { code?: string }): never {
    if (["PGRST202", "PGRST205", "42P01", "42883"].includes(error.code ?? "")) throw new ResearchError("Research storage is not available until its database migration is applied.", 503);
    if (["42501", "P0002"].includes(error.code ?? "")) throw new ResearchError("The project, question or source is unavailable.", 404);
    if (error.code === "22023") throw new ResearchError("The source or request changed. Reload and review before saving.", 409);
    throw new ResearchError("Research storage is temporarily unavailable. Your draft has not been discarded.", 503);
}
export function createResearchService(client: SupabaseClient, revisions: RevisionReader) {
    async function owned(table: string, id: string, userId: string): Promise<Row> {
        const { data, error } = await client.from(table).select("*").eq("id", id).eq("user_profile_id", userId).maybeSingle();
        if (error) databaseError(error);
        if (!data) throw new ResearchError("The requested research item is unavailable.", 404);
        return data;
    }
    async function getQuestion(id: string, userId: string): Promise<ResearchQuestion> {
        const result = question(await owned("research_questions", id, userId));
        await owned("projects", result.projectId, userId);
        return result;
    }
    async function getDocument(id: string, userId: string, projectId: string): Promise<ResearchDocument> {
        const { data, error } = await client.from("knowledge_documents").select("id,path,title,project_id,user_profile_id,scope,status").eq("id", id).maybeSingle();
        if (error) databaseError(error);
        if (!data || !documentInResearchScope(data, userId, projectId)) throw new ResearchError("This Library source is not available in the selected project.", 404);
        return data;
    }
    async function mutate(action: string, payload: Row, userId: string): Promise<Row> {
        const { data, error } = await client.rpc("assistant_research_mutate", { p_user_id: userId, p_action: action, p_payload: payload });
        if (error) databaseError(error);
        if (data?.conflict) throw new ResearchError("This item changed in another session. Your draft is retained; compare it with the latest saved version.", 409, data.current);
        if (data?.capacity === "questions") throw new ResearchError("Research supports 500 questions per profile, including archived questions. Edit an existing question; archiving does not free a slot. Your draft is retained.", 413);
        if (data?.capacity === "sources") throw new ResearchError("This question supports 500 saved source snapshots, including removed sources. Reselect an existing snapshot or use another question. Your draft is retained.", 413);
        if (data?.capacity === "entries") throw new ResearchError("This question supports 2,000 notes. Edit or delete an existing note, or use another question. Your draft is retained.", 413);
        if (!data) throw new ResearchError("Research save returned no record. Retry without discarding your draft.", 503);
        return data;
    }
    async function getSource(id: string, questionId: string, userId: string): Promise<ResearchSource> {
        const result = source(await owned("research_sources", id, userId));
        if (result.questionId !== questionId) throw new ResearchError("The source belongs to another research question.", 404);
        return result;
    }
    return {
        async list(userId: string) {
            const [{ data: projects, error: projectError }, { data: questions, error: questionError }] = await Promise.all([
                client.from("projects").select("id,name").eq("user_profile_id", userId).order("name"),
                client.from("research_questions").select("*").eq("user_profile_id", userId).order("updated_at", { ascending: false }).limit(501),
            ]);
            if (projectError || questionError) databaseError(projectError ?? questionError!);
            if ((questions?.length ?? 0) > 500) throw new ResearchError("This profile exceeds the 500-question listing limit, which includes archived questions. No records were silently omitted; existing data needs administrator review.", 413);
            const allowed = new Set((projects ?? []).map((item) => item.id));
            return { projects: projects ?? [], questions: (questions ?? []).filter((item) => allowed.has(item.project_id)).map(question) };
        },
        async workspace(id: string, userId: string): Promise<ResearchWorkspace> {
            const current = await getQuestion(id, userId);
            const [{ data: sources, error: sourceError }, { data: entries, error: entryError }, { data: documents, error: documentError }] = await Promise.all([
                client.from("research_sources").select("*").eq("question_id", id).eq("user_profile_id", userId).order("created_at").limit(501),
                client.from("research_entries").select("*").eq("question_id", id).eq("user_profile_id", userId).order("created_at").limit(2001),
                client.from("knowledge_documents").select("id,path,title,project_id,user_profile_id,scope,status").eq("status", "active")
                    .or(`project_id.eq.${current.projectId},project_id.is.null`).order("title").limit(501),
            ]);
            if (sourceError || entryError || documentError) databaseError(sourceError ?? entryError ?? documentError!);
            if ((sources?.length ?? 0) > 500 || (entries?.length ?? 0) > 2000 || (documents?.length ?? 0) > 500) throw new ResearchError("This workspace exceeds its listing safety limit. No sources or notes were silently omitted.", 413);
            return { question: current, sources: (sources ?? []).map(source), entries: (entries ?? []).map(entry),
                documents: (documents ?? []).filter((item) => documentInResearchScope(item, userId, current.projectId)) };
        },
        async saveQuestion(value: unknown, userId: string): Promise<ResearchQuestion> {
            const input = questionSchema.parse(value);
            await owned("projects", input.projectId, userId);
            if (input.version) {
                const current = await getQuestion(input.id, userId);
                if (current.projectId !== input.projectId) throw new ResearchError("A research question cannot be moved to another project.", 409);
            }
            return question(await mutate(input.version ? "update_question" : "create_question", input, userId));
        },
        async addSource(value: unknown, userId: string): Promise<ResearchSource> {
            const input = sourceSchema.parse(value);
            const current = await getQuestion(input.questionId, userId);
            const document = await getDocument(input.documentId, userId, current.projectId);
            const { data: existing, error: existingError } = await client.from("research_sources").select("*").eq("id", input.id).eq("user_profile_id", userId).maybeSingle();
            if (existingError) databaseError(existingError);
            if (existing) {
                if (existing.question_id !== input.questionId || existing.document_id !== input.documentId
                    || (input.commitSha && existing.commit_sha !== input.commitSha)) throw new ResearchError("The source request ID already belongs to another selection.", 409);
                return source(existing);
            }
            const commitSha = input.commitSha ?? (await revisions.list({ documentId: document.id })).headSha;
            const snapshot = await revisions.snapshot({ documentId: document.id, commitSha });
            if (snapshot.markdown.length > 1_000_000) throw new ResearchError("This source is too large for the passage reader.", 413);
            return source(await mutate("add_source", { ...input, commitSha: snapshot.commitSha, path: snapshot.path, contentHash: snapshot.contentHash, title: input.title ?? document.title.slice(0, 160) }, userId));
        },
        async editSource(value: unknown, userId: string): Promise<ResearchSource> {
            const input = editSourceSchema.parse(value);
            await getQuestion(input.questionId, userId);
            await getSource(input.id, input.questionId, userId);
            return source(await mutate("edit_source", input, userId));
        },
        async snapshot(sourceId: string, questionId: string, userId: string) {
            const current = await getQuestion(questionId, userId);
            const selected = await getSource(sourceId, questionId, userId);
            await getDocument(selected.documentId, userId, current.projectId);
            const snapshot = await revisions.snapshot({ documentId: selected.documentId, commitSha: selected.commitSha, path: selected.path });
            if (snapshot.documentId !== selected.documentId || snapshot.path !== selected.path || snapshot.commitSha !== selected.commitSha || snapshot.contentHash !== selected.contentHash) {
                throw new ResearchError("The saved source snapshot failed its identity check.", 409);
            }
            if (snapshot.markdown.length > 1_000_000) throw new ResearchError("This source is too large for the passage reader.", 413);
            const latest = await getQuestion(questionId, userId);
            await getDocument(selected.documentId, userId, latest.projectId);
            return { source: selected, markdown: snapshot.markdown };
        },
        async saveEntry(value: unknown, userId: string): Promise<ResearchEntry> {
            const input = parseResearchEntry(value);
            const current = await getQuestion(input.questionId, userId);
            const selected = input.sourceId ? await getSource(input.sourceId, input.questionId, userId) : null;
            let evidence = null;
            if (selected) {
                await getDocument(selected.documentId, userId, current.projectId);
                if (selected.removedAt && !input.version) throw new ResearchError("This source was removed. Select it again before adding a note.", 409);
            }
            if (input.kind !== "interpretation" && selected) {
                evidence = await revisions.evidence({ documentId: selected.documentId, path: selected.path, commitSha: selected.commitSha,
                    quote: input.quote!, startOffset: input.startOffset });
                assertEvidenceMatchesSource(evidence, selected);
            }
            return entry(await mutate(input.version ? "update_entry" : "create_entry", { ...input, evidence }, userId));
        },
        async deleteEntry(input: { id: string; questionId: string; version: number }, userId: string) {
            await getQuestion(input.questionId, userId);
            await mutate("delete_entry", input, userId);
            return { deleted: true, id: input.id };
        },
    };
}
