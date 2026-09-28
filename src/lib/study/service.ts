import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { knowledgeRevisions } from "../knowledge/revision-store";
import { cardInput, editInput, reviewInput, settingsInput, StudyError, type StudyCard, type StudyDocument, type StudyReport, type StudyReview } from "./contracts";
import { initialSchedule, nextReview } from "./scheduler";

type Row = Record<string, unknown>;
type Revisions = Pick<typeof knowledgeRevisions, "list" | "snapshot" | "evidence">;
export const studyRequestHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const card = (row: Row): StudyCard => ({ id: String(row.id), deck: String(row.deck), kind: row.kind as StudyCard["kind"], prompt: String(row.prompt), answer: String(row.answer), evidence: row.evidence as StudyCard["evidence"], schedule: row.schedule as StudyCard["schedule"], version: Number(row.version), active: row.active === true, updatedAt: String(row.updated_at) });
const review = (row: Row): StudyReview => ({ id: String(row.id), cardId: String(row.card_id), rating: Number(row.rating), response: String(row.response), reflection: String(row.reflection ?? ""), reviewedAt: String(row.reviewed_at), prompt: String(row.prompt), answer: String(row.answer), evidence: row.evidence as StudyReview["evidence"], version: Number(row.card_version) });
function databaseError(error: { code?: string } | null) {
    if (error) throw new StudyError(["PGRST202", "PGRST205", "42P01", "42883"].includes(error.code || "") ? "Study storage is not installed. Apply the V6 study migration, then retry." : "Study records are unavailable. Retry without discarding your draft.", 503);
}
export function createStudyService(db: SupabaseClient, revisions: Revisions, clock = () => new Date()) {
    async function documents(userId: string): Promise<StudyDocument[]> {
        const [{ data: projects, error: projectError }, { data, error }] = await Promise.all([
            db.from("projects").select("id").eq("user_profile_id", userId).abortSignal(AbortSignal.timeout(5000)),
            db.from("knowledge_documents").select("id,path,title,project_id,user_profile_id,scope,status").eq("status", "active").order("title").limit(1001).abortSignal(AbortSignal.timeout(5000)),
        ]);
        databaseError(error || projectError);
        if ((data?.length ?? 0) > 1000) throw new StudyError("The source list exceeds 1,000 documents. Narrow the library before loading study sources.", 413);
        const owned = new Set((projects ?? []).map(value => value.id));
        return (data ?? []).filter(value => (!value.user_profile_id || value.user_profile_id === userId) && (value.project_id ? owned.has(value.project_id) : ["user", "repository"].includes(value.scope))) as StudyDocument[];
    }
    async function authorisedDocument(id: string, userId: string) {
        const result = (await documents(userId)).find(value => value.id === id);
        if (!result) throw new StudyError("This source is not available to your profile.", 404);
        return result;
    }
    async function mutate(name: string, args: Record<string, unknown>) {
        const { data, error } = await db.rpc(name, args).abortSignal(AbortSignal.timeout(10000));
        databaseError(error);
        if (!data) throw new StudyError("The save was not confirmed. Retry the same request.", 503);
        if (data.error === "conflict") throw new StudyError("This card or request changed. Your draft is retained; refresh and compare before trying again.", 409);
        if (data.error === "missing") throw new StudyError("Study card not found.", 404);
        if (data.error === "not_due") throw new StudyError("This card is paused or not due. Refresh your review queue.", 409);
        if (data.error === "daily_limit") throw new StudyError("Your daily review limit has been reached. Return tomorrow or update your limit.", 409);
        if (data.error === "capacity") throw new StudyError("The 500-card study limit has been reached. Existing cards remain available to review and edit.", 413);
        if (data.error) throw new StudyError("Study save could not be confirmed.", 503);
        return data;
    }
    return {
        async report(userId: string): Promise<StudyReport> {
            const [data, sources] = await Promise.all([mutate("assistant_study_report", { p_user_id: userId }), documents(userId)]);
            if (!Array.isArray(data.cards) || !Array.isArray(data.reviews) || !data.settings) throw new StudyError("Study records could not be read.", 503);
            if (data.cards.length > 500) throw new StudyError("Study currently supports 500 cards per profile. No cards were silently omitted.", 413);
            return { profileId: userId, cards: data.cards.map(card), reviews: data.reviews.map(review), documents: sources,
                settings: { dailyLimit: data.settings.daily_limit, timezone: data.settings.timezone, version: data.settings.version },
                reviewedToday: data.reviewed_today, day: data.day, generatedAt: data.generated_at };
        },
        async snapshot(documentId: string, userId: string) {
            await authorisedDocument(documentId, userId);
            const { headSha } = await revisions.list({ documentId });
            return revisions.snapshot({ documentId, commitSha: headSha });
        },
        async create(value: unknown, userId: string) {
            const input = cardInput.parse(value);
            await authorisedDocument(input.documentId, userId);
            const evidence = await revisions.evidence({ documentId: input.documentId, commitSha: input.commitSha, path: input.path, quote: input.quote, startOffset: input.startOffset });
            const data = await mutate("assistant_study_save", { p_user_id: userId, p_action: "create", p_body: { id: input.id, deck: input.deck, kind: input.kind, prompt: input.prompt, answer: input.answer, evidence, schedule: initialSchedule(clock()), requestHash: studyRequestHash(input) } });
            return { card: card(data.card) };
        },
        async edit(value: unknown, userId: string) {
            const input = editInput.parse(value);
            return { card: card((await mutate("assistant_study_save", { p_user_id: userId, p_action: "edit", p_body: input })).card) };
        },
        async settings(value: unknown, userId: string) {
            const input = settingsInput.parse(value);
            return mutate("assistant_study_save", { p_user_id: userId, p_action: "settings", p_body: input });
        },
        async review(value: unknown, userId: string) {
            const input = reviewInput.parse(value);
            const { data, error } = await db.from("study_cards").select("*").eq("id", input.cardId).eq("user_profile_id", userId).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
            databaseError(error);
            if (!data) throw new StudyError("Study card not found.", 404);
            const scheduled = nextReview(card(data).schedule, input.rating, clock());
            const result = await mutate("assistant_study_review", { p_user_id: userId, p_body: { ...input, requestHash: studyRequestHash(input), schedule: scheduled.card, log: scheduled.log } });
            return { review: review(result.review), reused: result.reused === true };
        },
    };
}
