export interface AgentSelection { modelId?: string; reasoningEffort?: string }

interface SelectOption { value: string; name?: string }
interface SelectConfig {
    id: string;
    category?: string;
    currentValue?: string;
    options?: SelectOption[];
    type?: string;
}

export function selectConfig(options: unknown, category: "model" | "thought_level"): SelectConfig | null {
    if (!Array.isArray(options)) return null;
    const flattened = options.flatMap((option: unknown) => {
        if (!option || typeof option !== "object") return [];
        const row = option as Record<string, unknown>;
        if (Array.isArray(row.options) && !row.id) return row.options;
        return [row];
    });
    const found = flattened.find((option: unknown) => {
        if (!option || typeof option !== "object") return false;
        const row = option as Record<string, unknown>;
        return row.category === category || row.id === category || (category === "thought_level" && row.id === "reasoning_effort");
    });
    return found && typeof found === "object" ? found as SelectConfig : null;
}

export function validateSelection(params: {
    selection: AgentSelection; allowedModels: string[]; allowedReasoningEfforts: string[];
    configOptions: unknown;
}): { modelOption: SelectConfig | null; reasoningOption: SelectConfig | null } {
    const modelOption = selectConfig(params.configOptions, "model");
    const reasoningOption = selectConfig(params.configOptions, "thought_level");
    if (params.selection.modelId) {
        if (!params.allowedModels.includes(params.selection.modelId)) throw new Error(`model \"${params.selection.modelId}\" is not allowed by this Council instance`);
        if (!modelOption) throw new Error("the adapter did not advertise stable ACP model selection");
        if (!modelOption.options?.some((option) => option.value === params.selection.modelId)) throw new Error(`the adapter did not advertise model \"${params.selection.modelId}\"`);
    }
    if (params.selection.reasoningEffort) {
        if (!params.allowedReasoningEfforts.includes(params.selection.reasoningEffort)) throw new Error(`reasoning effort \"${params.selection.reasoningEffort}\" is not allowed`);
        if (!reasoningOption) throw new Error("the adapter did not advertise ACP reasoning selection");
        if (!reasoningOption.options?.some((option) => option.value === params.selection.reasoningEffort)) throw new Error(`the adapter did not advertise reasoning effort \"${params.selection.reasoningEffort}\"`);
    }
    return { modelOption, reasoningOption };
}
