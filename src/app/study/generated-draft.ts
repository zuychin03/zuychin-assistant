interface CardDraft { id: string; kind: string; prompt: string; answer: string }

export function applyGeneratedDraft<T extends CardDraft>(current: T | null, base: CardDraft, generated: { prompt: string; answer: string }): T | null {
    return current?.id === base.id && current.kind === base.kind && current.prompt === base.prompt && current.answer === base.answer
        ? { ...current, prompt: generated.prompt, answer: generated.answer } : current;
}
