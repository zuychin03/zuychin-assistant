import { z } from "zod";
import type { KnowledgeEvidence } from "../knowledge/revision-types";
import type { Card } from "ts-fsrs";

export type StudyKind = "recall" | "exercise" | "explain";
export type StudySchedule = Omit<Card, "due" | "last_review"> & { due: string; last_review?: string };
export interface StudyCard { id: string; deck: string; kind: StudyKind; prompt: string; answer: string; evidence: KnowledgeEvidence; schedule: StudySchedule; version: number; active: boolean; updatedAt: string }
export interface StudyReview { id: string; cardId: string; rating: number; response: string; reflection: string; reviewedAt: string; prompt: string; answer: string; evidence: KnowledgeEvidence; version: number; feedback: { text: string; model: string } | null }
export interface StudyFeedback { id: string; cardId: string; version: number; text: string; model: string; createdAt: string }
export interface StudyDraft { prompt: string; answer: string; generated: boolean; notice?: string }
export interface StudySettings { dailyLimit: number; timezone: string; version: number }
export interface StudyDocument { id: string; path: string; title: string; project_id: string | null; user_profile_id?: string | null; scope: string; status: string }
export interface StudyReport { profileId: string; cards: StudyCard[]; reviews: StudyReview[]; documents: StudyDocument[]; settings: StudySettings; reviewedToday: number; day: string; generatedAt: string }
export class StudyError extends Error { constructor(message: string, readonly status = 400) { super(message); this.name = "StudyError"; } }

const id = z.string().uuid();
const text = z.string().trim().min(1).max(20000);
const passage = { documentId: z.string().min(1).max(200), commitSha: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().min(1).max(1024), quote: z.string().min(1).max(20000), startOffset: z.number().int().nonnegative() };
const kind = z.enum(["recall", "exercise", "explain"]);
export const cardInput = z.object({ id, deck: z.string().trim().min(1).max(120), kind, prompt: text, answer: text, ...passage }).strict();
export const draftInput = z.object({ kind, ...passage }).strict();
export const feedbackInput = z.object({ id, cardId: id, version: z.number().int().positive(), response: text }).strict();
export const editInput = z.object({ id, version: z.number().int().positive(), deck: z.string().trim().min(1).max(120), prompt: text, answer: text, active: z.boolean() }).strict();
export const reviewInput = z.object({ id, cardId: id, version: z.number().int().positive(), rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), response: text, reflection: z.string().trim().max(20000).default(""), feedbackId: id.optional() }).strict();
export const settingsInput = z.object({ dailyLimit: z.number().int().min(1).max(200), timezone: z.string().min(1).max(100), version: z.number().int().nonnegative() }).strict().refine(value => { try { new Intl.DateTimeFormat("en-AU", { timeZone: value.timezone }); return true; } catch { return false; } }, "Choose a valid timezone.");
