import type { StudyCard, StudyFeedback } from "@/lib/study/contracts";

export function linkedFeedback(feedback: (StudyFeedback & { response: string }) | null, card: StudyCard, response: string): { feedbackId?: string } {
    return feedback && feedback.cardId === card.id && feedback.version === card.version && feedback.response === response.trim() ? { feedbackId: feedback.id } : {};
}

export function studyReviewState(cards: readonly StudyCard[], attempt: StudyCard | null, pendingCardId: string | undefined, deck: string, now: number) {
    if (pendingCardId) return { current: cards.find(card => card.id === pendingCardId), changed: false };
    if (attempt) {
        const latest = cards.find(card => card.id === attempt.id);
        const changed = !latest || latest.version !== attempt.version || !latest.active || Date.parse(latest.schedule.due) > now;
        return { current: attempt, changed };
    }
    return { current: cards.find(card => card.active && Date.parse(card.schedule.due) <= now && (!deck || card.deck === deck)), changed: false };
}
