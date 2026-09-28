import { createEmptyCard, fsrs, type Card, type Grade } from "ts-fsrs";
import { StudyError, type StudyKind, type StudySchedule } from "./contracts";

const scheduler = fsrs({ enable_fuzz: false });
const stored = (card: Card): StudySchedule => ({ ...card, due: card.due.toISOString(), ...(card.last_review ? { last_review: card.last_review.toISOString() } : {}) } as StudySchedule);
export function initialSchedule(now = new Date()): StudySchedule { return stored(createEmptyCard(now)); }
export function nextReview(card: StudySchedule, rating: Grade, now = new Date()) {
    if (![1, 2, 3, 4].includes(rating) || !Number.isFinite(Date.parse(card.due)) || (card.last_review && !Number.isFinite(Date.parse(card.last_review)))
        || ![0, 1, 2, 3].includes(card.state) || [card.stability, card.difficulty, card.elapsed_days, card.scheduled_days, card.learning_steps, card.reps, card.lapses].some(value => !Number.isFinite(value) || value < 0)) throw new StudyError("This card has an invalid review schedule.", 409);
    const result = scheduler.next(card, now, rating);
    return { card: stored(result.card), log: JSON.parse(JSON.stringify(result.log)) as Record<string, unknown> };
}
export function studyDay(now: Date, timezone: string): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}
export function studyDraft(kind: StudyKind, quote: string, title: string) {
    const prompt = kind === "recall" ? `Recall the key point from “${title}” without looking at the source.`
        : kind === "explain" ? `Explain the selected idea from “${title}” in your own words. State one limit or condition.`
        : `Apply the selected idea from “${title}” to an example. Show your steps and compare them with the source.`;
    return { prompt, answer: quote };
}
