// Chat client for the OpenAI-compatible providers (OpenRouter, NVIDIA NIM, OpenCode Zen).
// Runs the tool-calling loop, image input and reasoning. If a model rejects tools we
// just retry once without them so chat keeps working.

import {
    buildOpenAIToolDeclarations, executeTool, type OpenAITool,
} from "@/lib/ai/mcp-service";
import { getProviderApiKey, type ChatModel, type ProviderConfig, type GenParams } from "@/lib/ai/providers";
import type { ResolvedEmbedding } from "@/lib/ai/embeddings";
import type { FileAttachment } from "@/lib/types";

interface ToolCall {
    id?: string;
    type?: string;
    function: { name: string; arguments: string };
}

interface ChatChoiceMessage {
    role: string;
    // content can be a string, an array of parts, or null depending on the provider
    content: string | { text?: string }[] | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: ToolCall[];
}

interface ChatCompletion {
    choices?: { message: ChatChoiceMessage; finish_reason?: string }[];
    error?: { message?: string };
}

// message shapes (text or multimodal content)
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

// Some models (e.g. MiniMax) put their reasoning inside <think>...</think> tags
// in the content. Strip those out before showing the reply.
function stripThink(text: string): string {
    let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    // sometimes there's a closing tag with no opening one
    const close = t.lastIndexOf("</think>");
    if (close !== -1 && !/<think>/i.test(t)) {
        t = t.slice(close + "</think>".length);
    }
    return t.trim();
}

interface RequestOpts {
    thinking: boolean;
    genParams: GenParams;
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
    genParams?: GenParams;
}): Promise<string> {
    const { provider, model, systemText, userText, imageBase64, imageMimeType, file, embRef } = params;

    const apiKey = getProviderApiKey(provider);
    if (!apiKey) {
        throw new Error(`Missing API key (${provider.apiKeyEnv}) for ${provider.label}.`);
    }

    const opts: RequestOpts = {
        thinking: !!params.thinking && model.supportsThinking,
        genParams: params.genParams ?? {},
    };

    // build the user message - only send the image if the model can see images
    const userContent: ContentPart[] = [{ type: "text", text: userText }];
    if (model.supportsVision) {
        if (imageBase64) {
            const mime = imageMimeType || "image/jpeg";
            userContent.push({ type: "image_url", image_url: { url: `data:${mime};base64,${imageBase64}` } });
        }
        if (file && file.mimeType.startsWith("image/")) {
            userContent.push({ type: "image_url", image_url: { url: `data:${file.mimeType};base64,${file.base64}` } });
        }
    } else if (imageBase64 || (file && file.mimeType.startsWith("image/"))) {
        userContent[0] = { type: "text", text: `${userText}\n\n[An image was attached but ${model.label} is text-only, so it was not included.]` };
    } else if (file) {
        userContent[0] = { type: "text", text: `${userText}\n\n[Attached file: ${file.name} (${file.mimeType}). This model cannot read file attachments directly.]` };
    }

    // for text-only turns send a plain string - some models (MiniMax M3 on NIM)
    // don't accept the array-of-parts format.
    const userMessageContent: string | ContentPart[] =
        userContent.length === 1 && userContent[0].type === "text"
            ? userContent[0].text
            : userContent;

    const messages: ChatMessage[] = [
        { role: "system", content: systemText },
        { role: "user", content: userMessageContent },
    ];

    const tools = model.supportsTools ? buildOpenAIToolDeclarations() : undefined;

    // first request with tools + reasoning; if it fails, retry without them
    let data: ChatCompletion;
    try {
        data = await postChat(provider, apiKey, model.id, messages, tools, opts);
    } catch (err) {
        if (tools || opts.thinking) {
            console.warn(`[${provider.id}] request failed, retrying without tools/reasoning:`, err);
            data = await postChat(provider, apiKey, model.id, messages, undefined, { ...opts, thinking: false });
        } else {
            throw err;
        }
    }

    // MCP tool loop
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
                } catch {
                    /* leave args empty on malformed JSON */
                }
                const result = await executeTool(call.function.name, args, embRef);
                return { id: call.id, name: call.function.name, result };
            })
        );

        for (const r of results) {
            messages.push({ role: "tool", tool_call_id: r.id, name: r.name, content: r.result });
        }

        data = await postChat(provider, apiKey, model.id, messages, tools, opts);
    }

    let reply = extractReply(data);

    // sometimes the model returns empty content after tool use - try one more
    // plain request to get an actual answer
    if (!reply) {
        try {
            const plain = await postChat(provider, apiKey, model.id, messages, undefined, opts);
            reply = extractReply(plain);
        } catch (err) {
            console.error(`[${provider.id}] retry after empty response failed:`, err);
        }
    }

    return reply || "(The model returned an empty response.)";
}

// get the reply text out of a completion (content can be a string, an array of
// parts, or only in a reasoning field)
function extractReply(data: ChatCompletion): string {
    const msg = data.choices?.[0]?.message;
    if (!msg) return "";

    let raw = "";
    if (typeof msg.content === "string") {
        raw = msg.content;
    } else if (Array.isArray(msg.content)) {
        raw = msg.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
    }

    const content = stripThink(raw);
    if (content) return content;

    const reasoning = msg.reasoning_content ?? msg.reasoning;
    if (reasoning) return stripThink(String(reasoning));
    return "";
}

async function postChat(
    provider: ProviderConfig,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    tools: OpenAITool[] | undefined,
    opts: RequestOpts
): Promise<ChatCompletion> {
    const { thinking, genParams } = opts;

    // we stream and accumulate. Some NIM models (MiniMax M3) only reply over SSE -
    // a non-streaming request comes back with empty choices.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
        model,
        messages,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
        stream: true,
    };

    if (genParams.temperature !== undefined) body.temperature = genParams.temperature;
    if (genParams.topP !== undefined) body.top_p = genParams.topP;
    if (genParams.maxTokens !== undefined) body.max_tokens = genParams.maxTokens;

    // NVIDIA NIM expects sampling params and some models (MiniMax M3) 500 when
    // max_tokens is missing, so fill in NVIDIA's recommended defaults.
    if (provider.id === "nvidia-nim") {
        if (body.max_tokens === undefined) body.max_tokens = 8192;
        if (body.temperature === undefined) body.temperature = 1.0;
        if (body.top_p === undefined) body.top_p = 0.95;
    }

    // each provider turns on reasoning differently. Only send it when thinking is
    // on, otherwise some models (MiniMax M3) error on the extra param.
    if (thinking) {
        if (provider.id === "nvidia-nim") {
            body.chat_template_kwargs = { enable_thinking: true };
        } else if (provider.id === "openrouter") {
            body.reasoning = { effort: "high" };
        }
    }

    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(provider.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`${provider.label} ${res.status}: ${detail.slice(0, 400)}`);
    }
    if (!res.body) {
        throw new Error(`${provider.label}: empty stream body.`);
    }

    return accumulateStream(res.body, provider.label);
}

// read the SSE stream and rebuild a single ChatCompletion, joining the content,
// reasoning and tool-call deltas back together by index
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
