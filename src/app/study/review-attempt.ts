import type { StudyCard } from "@/lib/study/contracts";

export function studyReviewState(cards: readonly StudyCard[], attempt: StudyCard | null, pendingCardId: string | undefined, deck: string, now: number) {
    if (pendingCardId) return { current: cards.find(card => card.id === pendingCardId), changed: false };
    if (attempt) {
        const latest = cards.find(card => card.id === attempt.id);
        const changed = !latest || latest.version !== attempt.version || !latest.active || Date.parse(latest.schedule.due) > now;
        return { current: attempt, changed };
    }
    return { current: cards.find(card => card.active && Date.parse(card.schedule.due) <= now && (!deck || card.deck === deck)), changed: false };
}
