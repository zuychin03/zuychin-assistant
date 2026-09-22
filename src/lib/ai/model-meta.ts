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

const LAGUNA_S_21: ModelMeta = {
    developer: "Poolside",
    description: "Coding model for software engineering, terminal workflows and tool-driven agents.",
    inputs: ["Text"],
    context: "262K",
    params: "118B total · 8B active (MoE)",
    strengths: ["Coding", "Agentic", "Tool use", "Terminal", "Reasoning"],
};

const LAGUNA_XS_21: ModelMeta = {
    developer: "Poolside",
    description: "Compact Laguna model for coding and tool-driven software workflows.",
    inputs: ["Text"],
    strengths: ["Coding", "Agentic", "Tool use"],
};

const GEMMA_4_31B: ModelMeta = {
    developer: "Google DeepMind",
    description: "Dense multimodal Gemma model with image and video understanding, multilingual text and function calling.",
    inputs: ["Text", "Image", "Video"],
    context: "256K",
    params: "30.7B (dense)",
    strengths: ["Multimodal", "Vision", "Coding", "Multilingual", "Tool use"],
};

const GEMMA_4_26B_A4B: ModelMeta = {
    developer: "Google DeepMind",
    description: "Sparse multimodal Gemma model with native function calling and structured output.",
    inputs: ["Text", "Image", "Video"],
    context: "262K",
    params: "25.2B total · 3.8B active (MoE)",
    strengths: ["Efficient", "Multimodal", "Vision", "Tool use", "Reasoning", "Multilingual"],
};

const DIFFUSIONGEMMA_26B: ModelMeta = {
    developer: "Google DeepMind",
    description: "Multimodal text-diffusion model that refines blocks of tokens in parallel. This endpoint is used for tasks without tools.",
    inputs: ["Text", "Image", "Video"],
    context: "256K",
    params: "25.2B total · 3.8B active (MoE)",
    strengths: ["Fast", "Multimodal", "Efficient", "Multilingual"],
};

const GLM_53: ModelMeta = {
    developer: "Z.ai",
    description: "Text reasoning model for coding and long-context agent workflows, with configurable reasoning effort.",
    inputs: ["Text"],
    context: "1M",
    strengths: ["Coding", "Agentic", "Reasoning", "Tool use", "Long context"],
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

const MIMO_V26_FLASH: ModelMeta = {
    developer: "Xiaomi",
    description: "Multimodal Flash model for coding and agent tasks. OpenCode's free endpoint is restricted to the OpenCode client.",
    inputs: ["Text", "Image", "Audio", "Video"],
    context: "1M",
    strengths: ["Coding", "Agentic", "Reasoning", "Tool use", "Multimodal", "Fast"],
};

const GEMINI_EMBED_2: ModelMeta = {
    developer: "Google DeepMind",
    description: "Multimodal embedding model supporting text, images, video, audio and documents. Configured here at 768 dimensions.",
    inputs: ["Text", "Image", "Video", "Audio", "PDF"],
    strengths: ["Multimodal", "Multilingual", "Retrieval"],
};

const NEMOTRON_3_EMBED_1B: ModelMeta = {
    developer: "NVIDIA",
    description: "Multilingual text embedding model covering 34 languages, including Vietnamese. Produces 2048-dimensional vectors in a new space requiring re-embedding.",
    inputs: ["Text"],
    strengths: ["Retrieval", "Multilingual"],
};

const KIMI_K3: ModelMeta = {
    developer: "Moonshot AI",
    description: "Multimodal mixture-of-experts model for reasoning, coding and tool-driven tasks with a long context window.",
    inputs: ["Text", "Image"],
    context: "1M",
    params: "2.8T total · 104B active (MoE)",
    strengths: ["Reasoning", "Coding", "Agentic", "Vision", "Tool use", "Long context"],
};

export const MODEL_META: Record<string, ModelMeta> = {
    "gemini-3.8-flash": GEMINI_38_FLASH,
    "gemini-3.5-flash-lite": GEMINI_35_FLASH_LITE,
    "gemini-embedding-2": GEMINI_EMBED_2,
    "nvidia/nemotron-3-ultra-550b-a55b:free": NEMOTRON_3_ULTRA,
    "poolside/laguna-s-2.1:free": LAGUNA_S_21,
    "google/gemma-4-31b-it:free": GEMMA_4_31B,
    "google/gemma-4-26b-a4b-it": GEMMA_4_26B_A4B,
    "nvidia/nemotron-3.5-lightning:free": NEMOTRON_35_LIGHTNING,
    "moonshotai/kimi-k3": KIMI_K3,
    "z-ai/glm-5.3": GLM_53,
    "deepseek-ai/deepseek-v4.1-flash": DEEPSEEK_V41_FLASH,
    "deepseek-v4-pro": DEEPSEEK_V4_PRO,
    "deepseek-flash": { ...DEEPSEEK_V41_FLASH, maxOutput: "384K" },
    "nvidia/nemotron-3-ultra-550b-a55b": NEMOTRON_3_ULTRA,
    "google/gemma-4-31b-it": GEMMA_4_31B,
    "google/diffusiongemma-26b-a4b-it": DIFFUSIONGEMMA_26B,
    "z-ai/glm-5.3-flash": GLM_53_FLASH,
    "nvidia/nemotron-3.5-lightning-30b-a3b": NEMOTRON_35_LIGHTNING,
    "poolside/laguna-xs-2.1": LAGUNA_XS_21,
    "nvidia/nemotron-3-embed-1b": NEMOTRON_3_EMBED_1B,
    "mimo-v2.6-flash-free": MIMO_V26_FLASH,
    "nemotron-3.5-lightning-free": NEMOTRON_35_LIGHTNING,
    "moonshotai/kimi-k3-free": KIMI_K3,
};

export function getModelMeta(id: string): ModelMeta | null {
    return MODEL_META[id] ?? null;
}
