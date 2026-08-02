import {
    buildOpenAIToolDeclarations, executeTool, type OpenAITool,
} from "@/lib/ai/mcp-service";
import { getProviderApiKey, cappedMaxTokens, type ChatModel, type ProviderConfig, type GenParams } from "@/lib/ai/providers";
import {
    joinContinuation, segmentText, trimOverlap, ANSWER_NOW_PROMPT, CONTINUATION_BUDGET_MS,
    CONTINUE_PROMPT, MAX_CONTINUATIONS, TRUNCATION_NOTE, type Segment,
} from "@/lib/ai/continuation";
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

type TruncationCause = "timeout" | "stream_error" | "length";

interface ChatCompletion {
    choices?: { message: ChatChoiceMessage; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
    /** Set when the stream ended before the model finished; content is partial. */
    truncated?: TruncationCause;
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

// Every gateway on this path (NIM, OpenRouter, OpenCode Zen, TokenRouter) can
// end a request while the model is still writing, so long or reasoning-heavy
// answers stop mid-sentence. The resume contract lives in ./continuation.
const REQUEST_TIMEOUT_MS = 60_000;

// DeepSeek reasons before it emits anything, and v4-pro's minimum effort is
// "high", so first-token latency alone can outrun the default. Still inside
// CONTINUATION_BUDGET_MS, so a genuinely stuck request loses nothing.
const PROVIDER_TIMEOUT_MS: Record<string, number> = {
    deepseek: 120_000,
};

function requestTimeoutMs(providerId: string): number {
    return PROVIDER_TIMEOUT_MS[providerId] ?? REQUEST_TIMEOUT_MS;
}

const THINK_PAIR_RE = /<(think|thinking|thought|reason|reasoning)>[\s\S]*?<\/\1>/gi;
const THINK_OPEN_RE = /<(think|thinking|thought|reason|reasoning)>/i;
const THINK_CLOSE_RE = /<\/(think|thinking|thought|reason|reasoning)>/gi;

function stripThinkKeepSpace(text: string): string {
    let t = text.replace(THINK_PAIR_RE, "");
    if (!THINK_OPEN_RE.test(t)) {
        let cut = -1;
        let m: RegExpExecArray | null;
        THINK_CLOSE_RE.lastIndex = 0;
        while ((m = THINK_CLOSE_RE.exec(t)) !== null) cut = m.index + m[0].length;
        if (cut !== -1) t = t.slice(cut);
    }
    return t;
}

function stripThink(text: string): string {
    return stripThinkKeepSpace(text).trim();
}

// A cut stream can stop inside an unclosed reasoning block, which stripThink
// deliberately leaves whole. Everything from that tag on is deliberation.
function dropDanglingThink(text: string): string {
    const t = text.replace(THINK_PAIR_RE, "");
    const open = t.search(THINK_OPEN_RE);
    return open === -1 ? t : t.slice(0, open);
}

interface RequestOpts {
    thinking: boolean;
    genParams: GenParams;
    signal?: AbortSignal;
    /** Emits text deltas as they arrive; the reply is still assembled whole. */
    onToken?: (text: string) => void;
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
    onToken?: (text: string, reset?: boolean) => void;
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

    // Each model turn gets a fresh sink whose first delta resets the client's
    // forming bubble - a tool round's preamble text must not prefix the final
    // answer. Set on opts right before every postChat below.
    const nextTurnSink = () => {
        if (!params.onToken) return undefined;
        let first = true;
        return (text: string) => {
            params.onToken!(text, first);
            first = false;
        };
    };

    // A continuation extends the answer already on screen, so its deltas append
    // instead of resetting the bubble.
    const appendSink = () => {
        if (!params.onToken) return undefined;
        return (text: string) => params.onToken!(text);
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
        opts.onToken = nextTurnSink();
        data = await postChat(provider, apiKey, model.id, messages, tools, opts, forceSearch);
    } catch (err) {
        if (tools || opts.thinking) {
            console.warn(`[${provider.id}] request failed, retrying without tools/reasoning:`, err);
            data = await postChat(provider, apiKey, model.id, messages, undefined, { ...opts, thinking: false, onToken: nextTurnSink() });
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

        opts.onToken = nextTurnSink();
        data = await postChat(provider, apiKey, model.id, messages, tools, opts);
        trackUsage(data);
    }

    // Resumes an answer the provider cut off. Continuations run tool-free and
    // with reasoning off so the fresh window is spent finishing the prose.
    const completeTruncated = async (): Promise<string> => {
        const head = segmentPartial(data);
        let text = head.text;
        let seamSpaced = head.spaceAfter;
        const reasoning = extractReasoning(data);
        if (!text && !reasoning) return "";

        const startedAt = Date.now();
        for (let attempt = 0; attempt < MAX_CONTINUATIONS; attempt++) {
            if (Date.now() - startedAt > CONTINUATION_BUDGET_MS) break;

            const resumed: ChatMessage[] = [...messages];
            if (text) {
                resumed.push({ role: "assistant", content: text });
                resumed.push({ role: "user", content: CONTINUE_PROMPT });
            } else {
                resumed.push({ role: "assistant", content: `<partial-reasoning>\n${reasoning}\n</partial-reasoning>` });
                resumed.push({ role: "user", content: ANSWER_NOW_PROMPT });
            }

            let next: ChatCompletion;
            try {
                next = await postChat(provider, apiKey, model.id, resumed, undefined, {
                    ...opts,
                    thinking: false,
                    onToken: text ? appendSink() : nextTurnSink(),
                });
            } catch (err) {
                console.error(`[${provider.id}] continuation ${attempt + 1} failed:`, err);
                break;
            }
            trackUsage(next);

            const piece = next.truncated ? segmentPartial(next) : segmentContent(next);
            if (!piece.text) break;
            if (text) {
                const cut = trimOverlap(text, piece.text);
                const spaced = seamSpaced || (cut.spliced ? /^\s/.test(cut.text) : piece.spaceBefore);
                text = joinContinuation(text, cut.text, spaced);
            } else {
                text = piece.text;
            }
            seamSpaced = piece.spaceAfter;
            if (!next.truncated) return text;
        }
        return text ? text + TRUNCATION_NOTE : text;
    };

    let reply = data.truncated ? await completeTruncated() : extractContent(data);

    // Truncation already spent its retries above; only a genuinely empty answer
    // is worth another full window.
    if (!reply && !data.truncated) {
        try {
            const plain = await postChat(provider, apiKey, model.id, messages, undefined, { ...opts, thinking: false, onToken: nextTurnSink() });
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

function rawContent(data: ChatCompletion): string {
    const msg = data.choices?.[0]?.message;
    if (!msg) return "";

    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
    }
    return "";
}

function extractContent(data: ChatCompletion): string {
    return stripThink(rawContent(data));
}

function segment(raw: string): Segment {
    return segmentText(stripThinkKeepSpace(raw));
}

function segmentContent(data: ChatCompletion): Segment {
    return segment(rawContent(data));
}

/** Answer text salvaged from a stream that stopped before the model finished. */
function segmentPartial(data: ChatCompletion): Segment {
    return segment(dropDanglingThink(rawContent(data)));
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
    if (genParams.maxTokens !== undefined) body.max_tokens = cappedMaxTokens(genParams.maxTokens, model);

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

    // DeepSeek thinks by DEFAULT, so this branch runs whether or not the user
    // asked for it: leaving it out silently bills reasoning tokens on every
    // turn. reasoning_effort is not uniform - v4-pro rejects "low" - so the
    // thinking-off case turns the mode off rather than dialling the effort down.
    if (provider.id === "deepseek") {
        body.thinking = { type: thinking ? "enabled" : "disabled" };
        if (thinking) body.reasoning_effort = "high";
    }

    const timeoutMs = requestTimeoutMs(provider.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

        return await accumulateStream(res.body, provider.label, opts.onToken, () => !!opts.signal?.aborted);
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            if (opts.signal?.aborted) throw err;
            throw new Error(`${provider.label}: request timed out after ${timeoutMs / 1000}s.`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", onCallerAbort);
    }
}

async function accumulateStream(
    stream: ReadableStream<Uint8Array>,
    providerLabel: string,
    onToken?: (text: string) => void,
    callerAborted?: () => boolean
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
        if (typeof delta.content === "string") {
            content += delta.content;
            if (delta.content) onToken?.(delta.content);
        }
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

    let truncated: TruncationCause | undefined;
    try {
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
    } catch (err) {
        // A caller cancel drops the whole turn upstream, so never salvage it.
        if (callerAborted?.()) throw err;
        // With nothing accumulated the error is the only signal there is.
        if (!content && !reasoning && toolCalls.size === 0) throw err;
        truncated = err instanceof Error && err.name === "AbortError" ? "timeout" : "stream_error";
        console.warn(`[${providerLabel}] stream ended early, keeping partial output:`, err);
    }

    if (!truncated && finishReason === "length") truncated = "length";

    const assembledCalls = [...toolCalls.values()]
        .filter((c) => c.name && (!truncated || argsParse(c.args)))
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
        truncated,
    };
}

// A cut stream leaves the last call's arguments mid-JSON; running it would
// execute the tool with silently missing fields.
function argsParse(args: string): boolean {
    if (!args.trim()) return true;
    try {
        JSON.parse(args);
        return true;
    } catch {
        return false;
    }
}
