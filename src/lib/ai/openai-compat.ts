import {
    buildOpenAIToolDeclarations, executeTool, type OpenAITool,
} from "@/lib/ai/mcp-service";
import { getProviderApiKey, type ChatModel, type ProviderConfig, type GenParams } from "@/lib/ai/providers";
import type { ResolvedEmbedding } from "@/lib/ai/embeddings";
import { isTextLikeAttachment } from "@/lib/types";
import { formatTextAttachment } from "@/lib/attachments";
import type { ToolContext } from "@/lib/ai/mcp-service";
import type { FileAttachment } from "@/lib/types";

interface ToolCall {
    id?: string;
    type?: string;
    function: { name: string; arguments: string };
}

interface ChatChoiceMessage {
    role: string;
    content: string | { text?: string }[] | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: ToolCall[];
}

interface ChatCompletion {
    choices?: { message: ChatChoiceMessage; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
}

type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };
interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

const MAX_TOOL_ROUNDS = 5;

const REQUEST_TIMEOUT_MS = 60_000;

const THINK_PAIR_RE = /<(think|thinking|thought|reason|reasoning)>[\s\S]*?<\/\1>/gi;
const THINK_OPEN_RE = /<(think|thinking|thought|reason|reasoning)>/i;
const THINK_CLOSE_RE = /<\/(think|thinking|thought|reason|reasoning)>/gi;

function stripThink(text: string): string {
    let t = text.replace(THINK_PAIR_RE, "");
    if (!THINK_OPEN_RE.test(t)) {
        let cut = -1;
        let m: RegExpExecArray | null;
        THINK_CLOSE_RE.lastIndex = 0;
        while ((m = THINK_CLOSE_RE.exec(t)) !== null) cut = m.index + m[0].length;
        if (cut !== -1) t = t.slice(cut);
    }
    return t.trim();
}

interface RequestOpts {
    thinking: boolean;
    genParams: GenParams;
    signal?: AbortSignal;
}

export async function openaiCompatChat(params: {
    provider: ProviderConfig;
    model: ChatModel;
    systemText: string;
    userText: string;
    imageBase64?: string;
    imageMimeType?: string;
    file?: FileAttachment;
    embRef: ResolvedEmbedding;
    thinking?: boolean;
    search?: boolean;
    genParams?: GenParams;
    ctx?: ToolContext;
    onUsage?: (u: { promptTokens: number; outputTokens: number; totalTokens: number }) => void;
    signal?: AbortSignal;
}): Promise<string> {
    const { provider, model, systemText, userText, imageBase64, imageMimeType, file, embRef, ctx } = params;

    const usage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
    const trackUsage = (d: ChatCompletion) => {
        usage.promptTokens += d.usage?.prompt_tokens ?? 0;
        usage.outputTokens += d.usage?.completion_tokens ?? 0;
        usage.totalTokens += d.usage?.total_tokens ?? 0;
    };

    const apiKey = getProviderApiKey(provider);
    if (!apiKey) {
        throw new Error(`Missing API key (${provider.apiKeyEnv}) for ${provider.label}.`);
    }

    const opts: RequestOpts = {
        thinking: !!params.thinking && model.supportsThinking,
        genParams: params.genParams ?? {},
        signal: params.signal,
    };

    const isTextFile = !!file && isTextLikeAttachment(file.mimeType, file.name);
    const isImageFile = !!file && file.mimeType.startsWith("image/");

    let baseText = userText;
    if (file && isTextFile) {
        baseText = `${userText}\n\n${formatTextAttachment(file)}`;
    }

    const userContent: ContentPart[] = [{ type: "text", text: baseText }];
    if (model.supportsVision) {
        if (imageBase64) {
            const mime = imageMimeType || "image/jpeg";
            userContent.push({ type: "image_url", image_url: { url: `data:${mime};base64,${imageBase64}` } });
        }
        if (file && isImageFile) {
            userContent.push({ type: "image_url", image_url: { url: `data:${file.mimeType};base64,${file.base64}` } });
        }
    } else if (imageBase64 || isImageFile) {
        userContent[0] = { type: "text", text: `${baseText}\n\n[An image was attached but ${model.label} is text-only, so it was not included.]` };
    } else if (file && !isTextFile) {
        userContent[0] = { type: "text", text: `${baseText}\n\n[Attached file: ${file.name} (${file.mimeType}). This model cannot read this file type directly.]` };
    }

    const userMessageContent: string | ContentPart[] =
        userContent.length === 1 && userContent[0].type === "text"
            ? userContent[0].text
            : userContent;

    const messages: ChatMessage[] = [
        { role: "system", content: systemText },
        { role: "user", content: userMessageContent },
    ];

    const tools = model.supportsTools ? buildOpenAIToolDeclarations() : undefined;

    const forceSearch = !!params.search && !!tools
        ? { type: "function" as const, function: { name: "search_web" } }
        : undefined;

    let data: ChatCompletion;
    try {
        data = await postChat(provider, apiKey, model.id, messages, tools, opts, forceSearch);
    } catch (err) {
        if (tools || opts.thinking) {
            console.warn(`[${provider.id}] request failed, retrying without tools/reasoning:`, err);
            data = await postChat(provider, apiKey, model.id, messages, undefined, { ...opts, thinking: false });
        } else {
            throw err;
        }
    }
    trackUsage(data);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const msg = data.choices?.[0]?.message;
        const calls = msg?.tool_calls;
        if (!msg || !calls || calls.length === 0) break;

        messages.push({ role: "assistant", content: typeof msg.content === "string" ? msg.content : "", tool_calls: calls });

        const results = await Promise.all(
            calls.map(async (call) => {
                let args: Record<string, unknown> = {};
                try {
                    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                } catch { }
                const result = await executeTool(call.function.name, args, embRef, ctx);
                return { id: call.id, name: call.function.name, result };
            })
        );

        for (const r of results) {
            messages.push({ role: "tool", tool_call_id: r.id, name: r.name, content: r.result });
        }

        data = await postChat(provider, apiKey, model.id, messages, tools, opts);
        trackUsage(data);
    }

    let reply = extractContent(data);

    if (!reply) {
        try {
            const plain = await postChat(provider, apiKey, model.id, messages, undefined, { ...opts, thinking: false });
            trackUsage(plain);
            reply = extractContent(plain);
        } catch (err) {
            console.error(`[${provider.id}] retry after empty answer failed:`, err);
        }
    }

    if (!reply) reply = extractReasoning(data);

    params.onUsage?.(usage);
    return reply || "(The model returned an empty response.)";
}

function extractContent(data: ChatCompletion): string {
    const msg = data.choices?.[0]?.message;
    if (!msg) return "";

    let raw = "";
    if (typeof msg.content === "string") {
        raw = msg.content;
    } else if (Array.isArray(msg.content)) {
        raw = msg.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
    }
    return stripThink(raw);
}

function extractReasoning(data: ChatCompletion): string {
    const msg = data.choices?.[0]?.message;
    const reasoning = msg?.reasoning_content ?? msg?.reasoning;
    return reasoning ? stripThink(String(reasoning)) : "";
}

type ToolChoice = "auto" | { type: "function"; function: { name: string } };

async function postChat(
    provider: ProviderConfig,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    tools: OpenAITool[] | undefined,
    opts: RequestOpts,
    toolChoice: ToolChoice = "auto"
): Promise<ChatCompletion> {
    const { thinking, genParams } = opts;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
        model,
        messages,
        ...(tools ? { tools, tool_choice: toolChoice } : {}),
        stream: true,
    };

    if (genParams.temperature !== undefined) body.temperature = genParams.temperature;
    if (genParams.topP !== undefined) body.top_p = genParams.topP;
    if (genParams.maxTokens !== undefined) body.max_tokens = genParams.maxTokens;

    if (provider.id === "nvidia-nim") {
        if (body.max_tokens === undefined) body.max_tokens = 8192;
        if (body.temperature === undefined) body.temperature = 1.0;
        if (body.top_p === undefined) body.top_p = 0.95;
    }

    if (thinking) {
        if (provider.id === "nvidia-nim") {
            body.chat_template_kwargs = { enable_thinking: true };
        } else if (provider.id === "openrouter") {
            body.reasoning = { effort: "high" };
        }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onCallerAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onCallerAbort);
    if (opts.signal?.aborted) controller.abort();
    try {
        const res = await fetch(`${provider.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                ...(provider.extraHeaders ?? {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`${provider.label} ${res.status}: ${detail.slice(0, 400)}`);
        }
        if (!res.body) {
            throw new Error(`${provider.label}: empty stream body.`);
        }

        return await accumulateStream(res.body, provider.label);
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            if (opts.signal?.aborted) throw err;
            throw new Error(`${provider.label}: request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", onCallerAbort);
    }
}

async function accumulateStream(
    stream: ReadableStream<Uint8Array>,
    providerLabel: string
): Promise<ChatCompletion> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let content = "";
    let reasoning = "";
    let finishReason: string | undefined;
    const toolCalls = new Map<number, { id?: string; name: string; args: string }>();

    const handleData = (payload: string) => {
        if (payload === "[DONE]") return;
        let json: {
            error?: { message?: string };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            choices?: { delta?: any; finish_reason?: string }[];
        };
        try { json = JSON.parse(payload); } catch { return; }
        if (json.error) {
            throw new Error(`${providerLabel}: ${json.error.message ?? "stream error"}`);
        }

        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (!delta) {
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            return;
        }
        if (typeof delta.content === "string") content += delta.content;
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
        if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const cur = toolCalls.get(idx) ?? { id: undefined, name: "", args: "" };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name = tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                toolCalls.set(idx, cur);
            }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
    };

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const t = line.trim();
            if (t.startsWith("data:")) handleData(t.slice(5).trim());
        }
    }
    if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());

    const assembledCalls = [...toolCalls.values()]
        .filter((c) => c.name)
        .map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } }));

    return {
        choices: [{
            message: {
                role: "assistant",
                content: content || null,
                reasoning_content: reasoning || null,
                tool_calls: assembledCalls.length ? assembledCalls : undefined,
            },
            finish_reason: finishReason,
        }],
    };
}
