import type { HostSnapshot } from "@/app/council/host-client";

export interface ProposalSeatSelection { modelId?: string; reasoningEffort?: string }
export type ProposalSelections = Record<string, ProposalSeatSelection>;

export function proposalSeatChoices(snapshot: HostSnapshot | null, name: string) {
    const instance = snapshot?.instances?.find(item => item.name === name);
    const supported = snapshot?.capabilities?.protocolVersion === 3 && snapshot.capabilities.modelSelection === true;
    const selectable = supported && instance?.mode === "acp";
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()) : [];
    return { instance, supported, models: selectable ? strings(instance.allowedModels) : [], efforts: selectable ? strings(instance.allowedReasoningEfforts) : [] };
}

export function prepareProposalSelections(snapshot: HostSnapshot | null, names: string[], selections: ProposalSelections): { selections: ProposalSelections } | { error: string } {
    const entries: [string, ProposalSeatSelection][] = [];
    for (const name of names) {
        const selection = Object.hasOwn(selections, name) ? selections[name] : {};
        const choices = proposalSeatChoices(snapshot, name);
        if (selection.modelId && !choices.models.includes(selection.modelId)) return { error: `The selected model for ${name} is no longer available. Choose a listed model or restore the host default.` };
        if (selection.reasoningEffort && !choices.efforts.includes(selection.reasoningEffort)) return { error: `The selected reasoning effort for ${name} is no longer available. Choose a listed effort or restore the host default.` };
        if (selection.modelId || selection.reasoningEffort) entries.push([name, {
            ...(selection.modelId ? { modelId: selection.modelId } : {}),
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        }]);
    }
    return { selections: Object.fromEntries(entries) };
}
