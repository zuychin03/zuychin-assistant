export interface AgentSelection { modelId?: string; reasoningEffort?: string }

interface SelectOption { value: string; name?: string }
export interface SelectConfig {
    id: string;
    category?: string;
    currentValue?: string;
    options?: SelectOption[];
    type?: string;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function selectValues(options: unknown): SelectOption[] {
    if (!Array.isArray(options)) return [];
    return options.flatMap((option: unknown) => {
        const row = record(option);
        if (Array.isArray(row.options)) return selectValues(row.options);
        const value = text(row.value);
        return value ? [{ value, name: text(row.name) }] : [];
    });
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
    if (!found) return null;
    const row = record(found);
    const id = text(row.id);
    if (!id || (row.type !== undefined && row.type !== "select")) return null;
    return { id, category: text(row.category), type: "select", currentValue: text(row.currentValue), options: selectValues(row.options) };
}

export function sessionModelEvidence(response: unknown) {
    const session = record(response);
    const stableModel = selectConfig(session.configOptions, "model");
    const legacy = record(session.models);
    const legacyModel = text(legacy.currentModelId);
    const legacyOptions = Array.isArray(legacy.availableModels) ? legacy.availableModels.flatMap((option: unknown) => {
        const row = record(option);
        const value = text(row.modelId);
        return value ? [{ value, name: text(row.name) }] : [];
    }) : [];
    const modelOption: SelectConfig | null = stableModel ?? (legacyModel || legacyOptions.length ? {
        id: "model", currentValue: legacyModel, options: legacyOptions,
    } : null);
    return {
        modelOption,
        reasoningOption: selectConfig(session.configOptions, "thought_level"),
        modelSelection: Boolean(modelOption?.options?.length),
        modelSource: stableModel?.currentValue ? "adapter_config" : !stableModel && legacyModel ? "adapter_legacy_models" : "unknown",
    };
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

export async function configureAcpSession(params: {
    initialized: unknown;
    sessionResponse: unknown;
    selection: AgentSelection;
    allowedModels: string[];
    allowedReasoningEfforts: string[];
    setConfigOption: (configId: string, value: string) => Promise<unknown>;
    setLegacyModel?: (modelId: string) => Promise<unknown>;
}) {
    let response = params.sessionResponse;
    const adapterVersion = text(record(record(params.initialized).agentInfo).version) ?? null;
    if (params.selection.modelId && !selectConfig(record(response).configOptions, "model")) {
        const modelId = params.selection.modelId;
        if (!params.allowedModels.includes(modelId)) throw new Error(`model "${modelId}" is not allowed by this Council instance`);
        const evidence = sessionModelEvidence(response);
        if (!evidence.modelOption?.options?.some((option) => option.value === modelId)) {
            throw new Error(`the adapter did not advertise model "${modelId}"`);
        }
        if (!params.setLegacyModel) throw new Error("legacy ACP model selection is not available");
        if (params.selection.reasoningEffort) throw new Error("legacy model selection cannot confirm a simultaneous reasoning selection");
        const acknowledgement = await params.setLegacyModel(modelId);
        if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)) {
            throw new Error("the adapter returned an invalid legacy model acknowledgement");
        }
        return {
            effectiveModel: modelId, effectiveReasoningEffort: null, adapterVersion,
            modelSource: "adapter_legacy_set_model", modelSelection: true,
        };
    }
    const validate = (selection: AgentSelection) => validateSelection({ ...params, selection, configOptions: record(response).configOptions });
    const { modelOption } = validate({ modelId: params.selection.modelId });
    if (params.selection.reasoningEffort && !params.allowedReasoningEfforts.includes(params.selection.reasoningEffort)) {
        throw new Error(`reasoning effort "${params.selection.reasoningEffort}" is not allowed`);
    }
    if (params.selection.modelId && modelOption) {
        response = await params.setConfigOption(modelOption.id, params.selection.modelId);
        if (selectConfig(record(response).configOptions, "model")?.currentValue !== params.selection.modelId) {
            throw new Error("the adapter did not confirm the requested model");
        }
    }
    const { reasoningOption } = validate({ reasoningEffort: params.selection.reasoningEffort });
    if (params.selection.reasoningEffort && reasoningOption) {
        response = await params.setConfigOption(reasoningOption.id, params.selection.reasoningEffort);
        if (selectConfig(record(response).configOptions, "thought_level")?.currentValue !== params.selection.reasoningEffort) {
            throw new Error("the adapter did not confirm the requested reasoning effort");
        }
        if (params.selection.modelId && selectConfig(record(response).configOptions, "model")?.currentValue !== params.selection.modelId) {
            throw new Error("the adapter changed or omitted the model while setting reasoning effort");
        }
    }
    const evidence = sessionModelEvidence(response);
    return {
        effectiveModel: evidence.modelOption?.currentValue ?? null,
        effectiveReasoningEffort: evidence.reasoningOption?.currentValue ?? null,
        adapterVersion,
        modelSource: evidence.modelSource,
        modelSelection: evidence.modelSelection,
    };
}
