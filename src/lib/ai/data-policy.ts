import { getProvider } from "@/lib/ai/providers";
export const MODEL_DATA_CLASSES = ["personal", "knowledge", "public_search", "unattended"] as const;
export type ModelDataClass = typeof MODEL_DATA_CLASSES[number];
export interface DataRouteAssessment {
    tier: "free" | "paid" | "unknown";
    allowed: boolean | null;
    retention: "not_verified";
    rule: "interactive" | "scheduled_generation" | "shared_embedding_partition" | "unclassified";
}
const APPROVED_PROVIDERS = new Set(["gemini", "gemini-free", "openrouter", "kilo", "nvidia-nim", "deepseek", "opencode-zen"]);
export const DATA_ROUTE_RULES = {
    personal: ["free", "paid"], knowledge: ["free", "paid"], public_search: ["free", "paid"],
    unattended: ["paid_generation", "shared_embedding_partition"],
} as const;
export function assessDataRoute(input: { providerId: string; modelId: string; purpose: string; classes: ModelDataClass[]; freeOnly?: boolean }): DataRouteAssessment {
    const provider = getProvider(input.providerId);
    const speech = input.purpose === "speech" && input.providerId === "gemini" && input.modelId === (process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview");
    const model = speech ? { free: false } : provider && [...provider.chatModels, ...provider.embeddingModels].find(candidate => candidate.id === input.modelId);
    const tier = model?.free === true ? "free" : model?.free === false ? "paid" : "unknown";
    const scheduled = input.classes.includes("unattended"), embedding = input.purpose === "embedding";
    const rule = scheduled ? embedding ? "shared_embedding_partition" : "scheduled_generation" : input.classes.length ? "interactive" : "unclassified";
    if (!input.classes.length) return { tier, allowed: null, retention: "not_verified", rule };
    const registered = !!provider && !!model && APPROVED_PROVIDERS.has(provider.id) && !provider.unavailableReason && tier !== "unknown";
    const permitted = scheduled && !embedding ? input.providerId === "gemini" && tier === "paid" : !input.freeOnly || tier === "free";
    return { tier, allowed: registered && permitted, retention: "not_verified", rule };
}
export function assertDataRouteAllowed(assessment: DataRouteAssessment) {
    if (assessment.allowed === false) throw new Error("No allowed model route is available for this request's data policy. Check the configured model and key.");
}
export function mergeDataClasses(...values: (readonly ModelDataClass[] | undefined)[]): ModelDataClass[] {
    const present = new Set(values.flatMap(value => value ?? []));
    return MODEL_DATA_CLASSES.filter(value => present.has(value));
}
