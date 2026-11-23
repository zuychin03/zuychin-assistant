export interface ModelMeta {
    developer: string;
    description: string;
    inputs: string[];
    context?: string;
    maxOutput?: string;
    params?: string;
    strengths: string[];
}

const GEMINI_38_FLASH: ModelMeta = {
    developer: "Google DeepMind",
    description: "Multimodal Flash model with configurable thinking, function calling and structured output.",
    inputs: ["Text", "Image", "Audio", "Video", "PDF"],
    context: "1M",
    maxOutput: "64K",
    strengths: ["Coding", "Agentic", "Multimodal", "Reasoning", "Tool use", "Fast"],
};

const GEMINI_35_FLASH_LITE: ModelMeta = {
    developer: "Google DeepMind",
    description: "Flash-Lite model for low-latency multimodal tasks, with thinking and function calling.",
    inputs: ["Text", "Image", "Audio", "Video", "PDF"],
    context: "1M",
    maxOutput: "64K",
    strengths: ["Agentic", "Coding", "Reasoning", "Multimodal", "Fast"],
};

const NEMOTRON_3_ULTRA: ModelMeta = {
    developer: "NVIDIA",
    description: "Hybrid Mamba-Attention mixture-of-experts model for text reasoning, coding and tool-driven workflows.",
    inputs: ["Text"],
    context: "1M",
    params: "550B total · 55B active (MoE)",
    strengths: ["Reasoning", "Agentic", "Coding", "Math", "Long context", "Tool use"],
};

const NEMOTRON_35_LIGHTNING: ModelMeta = {
    developer: "NVIDIA",
    description: "Sparse text model for reasoning and agent workflows with tool calling. Endpoint latency varies by provider.",
    inputs: ["Text"],
    context: "1M",
    params: "30B total · 3B active (MoE)",
    strengths: ["Reasoning", "Agentic", "Coding", "Tool use", "Fast"],
};

const GLM_53_FLASH: ModelMeta = {
    developer: "Z.ai",
    description: "Multimodal Flash model for reasoning and tool-driven tasks, with image understanding.",
    inputs: ["Text", "Image"],
    params: "320B total · 18B active (MoE)",
    strengths: ["Coding", "Agentic", "Reasoning", "Tool use", "Vision", "Fast"],
};

const DEEPSEEK_V4_PRO: ModelMeta = {
    developer: "DeepSeek",
    description: "Text reasoning model for coding and agent workflows. The direct API supports function calling and JSON-object output.",
    inputs: ["Text"],
    context: "1M",
    maxOutput: "384K",
    strengths: ["Reasoning", "Coding", "Math", "Agentic", "Long context", "Tool use"],
};

const DEEPSEEK_V41_FLASH: ModelMeta = {
    developer: "DeepSeek",
    description: "Multimodal Flash model with reasoning and image understanding. Tool support depends on the serving endpoint.",
    inputs: ["Text", "Image"],
    context: "1M",
    strengths: ["Coding", "Reasoning", "Vision", "Fast", "Long context"],
};

const GEMINI_EMBED_2: ModelMeta = {
    developer: "Google DeepMind",
    description: "Multimodal embedding model supporting text, images, video, audio and documents. Configured here at 768 dimensions.",
    inputs: ["Text", "Image", "Video", "Audio", "PDF"],
    strengths: ["Multimodal", "Multilingual", "Retrieval"],
};

const NEMOTRON_3_EMBED_1B: ModelMeta = {
    developer: "NVIDIA",
    description: "Retired by NVIDIA on 23/11/2026. Multilingual text embedding model covering 34 languages, including Vietnamese, with 2048-dimensional vectors.",
    inputs: ["Text"],
    strengths: ["Retrieval", "Multilingual"],
};

const NEMOTRON_35_EMBED_1B: ModelMeta = {
    developer: "NVIDIA",
    description: "Text embedding model that replaced Nemotron 3 Embed 1B. Produces 2048-dimensional vectors in a new space, so switching to it needs a re-embed.",
    inputs: ["Text"],
    strengths: ["Retrieval"],
};

export const MODEL_META: Record<string, ModelMeta> = {
    "gemini-3.8-flash": GEMINI_38_FLASH,
    "gemini-3.5-flash-lite": GEMINI_35_FLASH_LITE,
    "gemini-embedding-2": GEMINI_EMBED_2,
    "nvidia/nemotron-3.5-lightning:free": NEMOTRON_35_LIGHTNING,
    "deepseek-v4-pro": DEEPSEEK_V4_PRO,
    "deepseek-flash": { ...DEEPSEEK_V41_FLASH, maxOutput: "384K" },
    "nvidia/nemotron-3-ultra-550b-a55b": NEMOTRON_3_ULTRA,
    "z-ai/glm-5.3-flash": GLM_53_FLASH,
    "nvidia/nemotron-3.5-lightning-30b-a3b": NEMOTRON_35_LIGHTNING,
    "nvidia/nemotron-3-embed-1b": NEMOTRON_3_EMBED_1B,
    "nvidia/nemotron-3.5-embed-1b": NEMOTRON_35_EMBED_1B,
};

export function getModelMeta(id: string): ModelMeta | null {
    return MODEL_META[id] ?? null;
}
