export interface ModelPickerOption {
    value: string;
    label: string;
    searchTerms?: string[];
}

export interface ModelPickerGroup {
    label: string;
    options: ModelPickerOption[];
}

interface SearchableModel {
    id: string;
    dimension?: number;
    supportsTools?: boolean;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    supportsSearch?: boolean;
    supportsStructuredOutput?: boolean;
    meta?: { developer: string; strengths: string[] } | null;
}

export function modelSearchTerms(model: SearchableModel): string[] {
    const capabilityStrengths = new Set(["Vision", "Multimodal", "Tool use", "Reasoning"]);
    return [
        model.id,
        model.meta?.developer ?? "",
        ...(model.meta?.strengths.filter((strength) => !capabilityStrengths.has(strength)) ?? []),
        ...(model.supportsTools ? ["tools tool function calling"] : []),
        ...(model.supportsVision ? ["vision image images multimodal"] : []),
        ...(model.supportsThinking ? ["reasoning thinking"] : []),
        ...(model.supportsSearch ? ["web search"] : []),
        ...(model.supportsStructuredOutput ? ["structured output JSON schema"] : []),
        ...(model.dimension ? [`embedding retrieval ${model.dimension} dimensions`] : []),
    ].filter(Boolean);
}

function searchableText(value: string): string {
    return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[-_]/g, " ");
}

export function filterModelGroups(groups: ModelPickerGroup[], query: string): ModelPickerGroup[] {
    const terms = searchableText(query).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return groups;
    return groups.map((group) => ({
        ...group,
        options: group.options.filter((option) => {
            const text = searchableText([group.label, option.label, option.value, ...(option.searchTerms ?? [])].join(" "));
            return terms.every((term) => text.includes(term));
        }),
    })).filter((group) => group.options.length > 0);
}

export function nextModelOption(index: number, count: number, key: string): number {
    if (!count) return -1;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    if (key === "ArrowDown") return Math.min(index + 1, count - 1);
    if (key === "ArrowUp") return Math.max(index - 1, 0);
    return index;
}
