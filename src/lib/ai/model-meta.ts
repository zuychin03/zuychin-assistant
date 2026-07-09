export interface ModelMeta {
    developer: string;
    description: string;
    inputs: string[];
    context?: string;
    maxOutput?: string;
    params?: string;
    strengths: string[];
}

const GEMINI_35_FLASH: ModelMeta = {
    developer: "Google DeepMind",
    description:
        "Google's fastest frontier thinking model. Optimized for coding and parallel agentic loops, with leading multimodal understanding and explicit thinking levels that trade quality for latency.",
    inputs: ["Text", "Image", "Audio", "Video", "PDF"],
    context: "1M",
    maxOutput: "64K",
    strengths: ["Coding", "Agentic", "Multimodal", "Reasoning", "Tool use", "Fast"],
};

const GEMINI_3_FLASH: ModelMeta = {
    developer: "Google DeepMind",
    description:
        "High-speed thinking model for agentic workflows, multi-turn chat and coding, delivering near-Pro reasoning and tool use at much lower latency.",
    inputs: ["Text", "Image", "Audio", "Video", "PDF"],
    context: "1M",
    maxOutput: "64K",
    strengths: ["Agentic", "Coding", "Reasoning", "Multimodal", "Fast"],
};

const NEMOTRON_3_ULTRA: ModelMeta = {
    developer: "NVIDIA",
    description:
        "NVIDIA's flagship open MoE with a hybrid Mamba-Attention design. Built for long-running agents — orchestration, coding agents, deep research — with reasoning-budget control over code, math and science.",
    inputs: ["Text"],
    context: "1M",
    maxOutput: "64K",
    params: "550B total · 55B active (MoE)",
    strengths: ["Reasoning", "Agentic", "Coding", "Math", "Science", "Long context"],
};

const LAGUNA_M1: ModelMeta = {
    developer: "Poolside",
    description:
        "Poolside's flagship coding-agent model, trained from scratch on 30T tokens. Reaches 72.5% on SWE-bench Verified and is tuned for real software-engineering and tool-driven workflows.",
    inputs: ["Text"],
    context: "256K",
    maxOutput: "32K",
    params: "225B total · 23B active (MoE)",
    strengths: ["Coding", "Agentic", "Tool use", "Reasoning"],
};

const GEMMA_4_31B: ModelMeta = {
    developer: "Google DeepMind",
    description:
        "Compact multimodal model that handles text, image and video and runs on consumer GPUs. 140+ languages, native function calling, and a 256K context — strong coding for its size (~68% SWE-bench Verified).",
    inputs: ["Text", "Image", "Video"],
    context: "256K",
    params: "30.7B (dense)",
    strengths: ["Multimodal", "Vision", "Coding", "Reasoning", "Multilingual", "Tool use"],
};

const GEMMA_4_26B_A4B: ModelMeta = {
    developer: "Google DeepMind",
    description:
        "Instruction-tuned Gemma 4 MoE that reaches near-31B quality at a fraction of the compute through sparse activation. Handles text, image and video with native function calling and structured outputs over a 262K context.",
    inputs: ["Text", "Image", "Video"],
    context: "262K",
    params: "25.2B total · 3.8B active (MoE)",
    strengths: ["Efficient", "Multimodal", "Vision", "Tool use", "Reasoning", "Multilingual"],
};

const GPT_OSS_120B: ModelMeta = {
    developer: "OpenAI",
    description:
        "OpenAI's open-weight MoE built for agentic tasks and configurable reasoning. Near-parity with o4-mini on reasoning benchmarks, with adjustable reasoning effort, native tool use and a 131K context.",
    inputs: ["Text"],
    context: "131K",
    params: "117B total · 5.1B active (MoE)",
    strengths: ["Reasoning", "Agentic", "Tool use", "Coding", "Math"],
};

const MINIMAX_M3: ModelMeta = {
    developer: "MiniMax",
    description:
        "Multimodal MoE vision-language model for long-horizon agentic work — multi-hour coding, up-to-30-minute video understanding and strong tool use over a 1M-token context.",
    inputs: ["Text", "Image", "Video"],
    context: "1M",
    params: "428B total · 22B active (MoE)",
    strengths: ["Coding", "Agentic", "Multimodal", "Video", "Long context", "Tool use"],
};

const DIFFUSIONGEMMA_26B: ModelMeta = {
    developer: "Google DeepMind",
    description:
        "Google's first open text-diffusion model. Instead of decoding one token at a time, it refines a 256-token block in parallel for up to 4x faster generation (1000+ tok/s on an H100), and accepts interleaved text, image and video input across 140+ languages.",
    inputs: ["Text", "Image", "Video"],
    context: "256K",
    params: "25.2B total · 3.8B active (MoE)",
    strengths: ["Fast", "Multimodal", "Efficient", "Multilingual"],
};

const STEP_37_FLASH: ModelMeta = {
    developer: "StepFun",
    description:
        "Multimodal MoE vision-language model for agentic coding, tool orchestration and search-heavy workflows. Exposes selectable reasoning levels (high/medium/low) to trade depth for speed over a 256K context.",
    inputs: ["Text", "Image", "Video"],
    context: "256K",
    maxOutput: "256K",
    params: "198B total · 11B active (MoE)",
    strengths: ["Coding", "Agentic", "Vision", "Tool use", "Reasoning", "Search"],
};

const GLM_5_2: ModelMeta = {
    developer: "Z.ai",
    description:
        "Z.ai's latest flagship MoE for long-horizon engineering. GLM-5.2 adds a solid 1M-token context with IndexShare sparse attention, flexible thinking effort levels, and stronger coding, terminal and agentic performance over GLM-5.1.",
    inputs: ["Text"],
    context: "1M",
    maxOutput: "128K",
    params: "753B total · 40B active (MoE)",
    strengths: ["Coding", "Agentic", "Reasoning", "Tool use", "Long context", "Math", "Terminal ops"],
};

const MINIMAX_M2_7: ModelMeta = {
    developer: "MiniMax",
    description:
        "Sparse MoE tuned for agentic coding and chat — long-horizon software engineering, live troubleshooting and document generation. A self-evolving training loop pushes its coding scores near frontier models.",
    inputs: ["Text"],
    context: "200K",
    params: "230B total · 10B active (MoE)",
    strengths: ["Coding", "Agentic", "Tool use", "Reasoning", "Long context"],
};

const QWEN_35: ModelMeta = {
    developer: "Alibaba Qwen",
    description:
        "Qwen's first natively multimodal open MoE, unifying the text and vision model lines. Supports switchable reasoning/non-reasoning modes, image and video input, and 201 languages, with strong logic, math and code over a 256K context.",
    inputs: ["Text", "Image", "Video"],
    context: "256K",
    params: "397B total · 17B active (MoE)",
    strengths: ["Reasoning", "Coding", "Math", "Multimodal", "Multilingual", "Agentic"],
};

const DEEPSEEK_V4_PRO: ModelMeta = {
    developer: "DeepSeek",
    description:
        "DeepSeek's flagship for advanced reasoning, coding and long-running agents, with a 1M-token context built for agentic workloads. Strong on knowledge, math and software-engineering benchmarks.",
    inputs: ["Text"],
    context: "1M",
    params: "1.6T total · 49B active (MoE)",
    strengths: ["Reasoning", "Coding", "Math", "Agentic", "Knowledge", "Long context"],
};

const DEEPSEEK_V4_FLASH: ModelMeta = {
    developer: "DeepSeek",
    description:
        "Fast, cost-efficient sibling of V4 Pro. Tuned for high-throughput inference while holding up on reasoning and coding, and matching Pro-level reasoning when given a larger thinking budget.",
    inputs: ["Text"],
    context: "1M",
    params: "284B total · 13B active (MoE)",
    strengths: ["Coding", "Reasoning", "Fast", "High throughput", "Long context"],
};

const MIMO_V25: ModelMeta = {
    developer: "Xiaomi",
    description:
        "Xiaomi's sparse MoE with hybrid sliding-window attention for efficient long context. Strong on everyday coding and agentic tasks via large-scale agentic RL post-training.",
    inputs: ["Text"],
    context: "1M",
    params: "310B total · 15B active (MoE)",
    strengths: ["Coding", "Agentic", "Reasoning", "Tool use", "Long context"],
};

const GEMINI_EMBED_2: ModelMeta = {
    developer: "Google DeepMind",
    description:
        "Google's first natively multimodal embedding model — text, images, video, audio and docs in one space. Leads the MTEB English (68.32) and Code (74.66) benchmarks. Used here at 768 dimensions.",
    inputs: ["Text", "Image", "Video", "Audio", "PDF"],
    strengths: ["Multimodal", "Multilingual", "Retrieval", "Code"],
};

const NEMOTRON_EMBED_1B: ModelMeta = {
    developer: "NVIDIA",
    description:
        "Lightweight text retriever (fine-tuned Llama 3.2 1B) for multilingual and cross-lingual question-answering, with long-document support up to 8192 tokens across 26 languages. Outputs 2048-dimensional vectors.",
    inputs: ["Text"],
    strengths: ["Retrieval", "Multilingual", "Long context", "Fast"],
};

const LLAMA_EMBED_8B: ModelMeta = {
    developer: "NVIDIA",
    description:
        "NVIDIA's universal text embedding model (7.5B), ranked #1 on the multilingual MTEB leaderboard. Instruction-aware, tuned for retrieval, reranking, semantic similarity and classification. Outputs 4096-dimensional vectors.",
    inputs: ["Text"],
    strengths: ["Retrieval", "Multilingual", "Reranking", "Classification"],
};

const QWEN3_NEXT_80B: ModelMeta = {
    developer: "Alibaba Qwen",
    description:
        "Instruction-tuned Qwen3-Next MoE built for fast, stable chat without visible thinking traces. Hybrid attention and high-sparsity experts target long-context RAG, tool use and agent workflows with deterministic final answers.",
    inputs: ["Text"],
    context: "262K",
    params: "80B total · 3B active (MoE)",
    strengths: ["Long context", "Agentic", "Tool use", "Coding", "Fast", "RAG"],
};

export const MODEL_META: Record<string, ModelMeta> = {
    "gemini-3.5-flash": GEMINI_35_FLASH,
    "gemini-3-flash-preview": GEMINI_3_FLASH,
    "gemini-embedding-2-preview": GEMINI_EMBED_2,
    "nvidia/nemotron-3-ultra-550b-a55b:free": NEMOTRON_3_ULTRA,
    "poolside/laguna-m.1:free": LAGUNA_M1,
    "google/gemma-4-31b-it:free": GEMMA_4_31B,
    "google/gemma-4-26b-a4b-it": GEMMA_4_26B_A4B,
    "openai/gpt-oss-120b:free": GPT_OSS_120B,
    "qwen/qwen3-next-80b-a3b-instruct:free": QWEN3_NEXT_80B,
    "minimaxai/minimax-m3": MINIMAX_M3,
    "deepseek-ai/deepseek-v4-pro": DEEPSEEK_V4_PRO,
    "deepseek-ai/deepseek-v4-flash": DEEPSEEK_V4_FLASH,
    "nvidia/nemotron-3-ultra-550b-a55b": NEMOTRON_3_ULTRA,
    "google/gemma-4-31b-it": GEMMA_4_31B,
    "google/diffusiongemma-26b-a4b-it": DIFFUSIONGEMMA_26B,
    "stepfun-ai/step-3.7-flash": STEP_37_FLASH,
    "z-ai/glm-5.2": GLM_5_2,
    "minimaxai/minimax-m2.7": MINIMAX_M2_7,
    "qwen/qwen3.5-397b-a17b": QWEN_35,
    "qwen/qwen3-next-80b-a3b-instruct": QWEN3_NEXT_80B,
    "nvidia/llama-nemotron-embed-1b-v2": NEMOTRON_EMBED_1B,
    "nvidia/llama-embed-nemotron-8b": LLAMA_EMBED_8B,
    "mimo-v2.5-free": MIMO_V25,
    "deepseek-v4-flash-free": DEEPSEEK_V4_FLASH,
};

export function getModelMeta(id: string): ModelMeta | null {
    return MODEL_META[id] ?? null;
}
