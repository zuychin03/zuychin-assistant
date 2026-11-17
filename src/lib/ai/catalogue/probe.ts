import { deflateSync } from "node:zlib";
import { beginModelObservation } from "@/lib/ai/model-observations";
import type { ProviderConfig } from "@/lib/ai/providers";

// Synthetic requests shaped like the app's own (streamed, same tool and image formats), with a
// tool that is never dispatched, so a probe never reaches real tools, the knowledge base or search.

export type ProbeStepName = "chat" | "tools" | "forced" | "vision";
export type ProbeOutcome = "pass" | "fail" | "transient" | "skipped";

export interface ProbeStep {
    outcome: ProbeOutcome;
    httpStatus: number | null;
    ms: number | null;
    detail: string | null;
}

export interface ProbeResult {
    status: "passed" | "failed" | "inconclusive";
    /** HTTP 410: the provider says the model is gone. */
    retired: boolean;
    chatMs: number | null;
    supportsTools: boolean | null;
    /** A forced tool choice came back as a call, which the Search toggle relies on. */
    supportsSearch: boolean | null;
    supportsVision: boolean | null;
    steps: Record<ProbeStepName, ProbeStep>;
}

export interface ProbeTarget {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
    /** Set when the list claims image input or says nothing about inputs. */
    checkVision: boolean;
}

export interface ProbeOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeouts?: Partial<Record<ProbeStepName, number>>;
}

// Timeouts follow the September audit: tool calls on free routes took up to about 106 s.
const DEFAULT_TIMEOUTS: Record<ProbeStepName, number> = { chat: 60_000, tools: 120_000, forced: 120_000, vision: 60_000 };
const MAX_TOKENS = 2048;
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const TOOL_NAME = "probe_echo";
const TOOL_DESCRIPTION = "Echoes the given text back. Call it when asked to echo text.";
const ECHO_WORD = "zuychin";
const COLOUR_WORD = /\bred\b/i;
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const DETAIL_MAX = 200;

const PROMPTS: Record<ProbeStepName, string> = {
    chat: "Reply with OK.",
    tools: `Call the ${TOOL_NAME} tool with the text "${ECHO_WORD}". Do not answer in prose.`,
    forced: `Echo the word "${ECHO_WORD}".`,
    vision: "What colour fills this image? Answer with one word.",
};

interface Exchange {
    httpStatus: number | null;
    text: string;
    reasoning: string;
    calls: { name: string; args: string }[];
    error: string | null;
    timedOut: boolean;
    transport: boolean;
    ms: number;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

/** A solid-colour RGB PNG, built here so the probe needs no image file. */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
    const pixels = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(pixels)),
        pngChunk("IEND", new Uint8Array()),
    ]);
}

let probeImage: string | null = null;
function probeImageBase64(): string {
    probeImage ??= solidPng(64, 64, [220, 38, 38]).toString("base64");
    return probeImage;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorDetail(body: string, status: number): string {
    try {
        const json = record(JSON.parse(body));
        const error = record(json.error);
        const message = error.message ?? json.message ?? json.detail ?? json.error;
        if (typeof message === "string" && message.trim()) return message.trim().slice(0, DETAIL_MAX);
    } catch { /* not JSON */ }
    return body.trim().slice(0, DETAIL_MAX) || `HTTP ${status}`;
}

// The app sends these when thinking is off; a probe matches that so it tests the same request.
function thinkingOff(providerId: string): Record<string, unknown> {
    if (providerId === "kilo") return { reasoning: { enabled: false } };
    if (providerId === "deepseek") return { thinking: { type: "disabled" } };
    return {};
}

function openAiBody(target: ProbeTarget, step: ProbeStepName): Record<string, unknown> {
    const content = step === "vision"
        ? [{ type: "text", text: PROMPTS.vision }, { type: "image_url", image_url: { url: `data:image/png;base64,${probeImageBase64()}` } }]
        : PROMPTS[step];
    const tools = [{ type: "function", function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: { type: "object", properties: { text: { type: "string", description: "Text to echo." } }, required: ["text"] } } }];
    return {
        model: target.modelId,
        messages: [{ role: "user", content }],
        max_tokens: MAX_TOKENS,
        stream: true,
        ...thinkingOff(target.provider.id),
        ...(step === "tools" ? { tools, tool_choice: "auto" } : {}),
        ...(step === "forced" ? { tools, tool_choice: { type: "function", function: { name: TOOL_NAME } } } : {}),
    };
}

function geminiBody(step: ProbeStepName): Record<string, unknown> {
    const parts: Record<string, unknown>[] = [{ text: PROMPTS[step] }];
    if (step === "vision") parts.push({ inlineData: { mimeType: "image/png", data: probeImageBase64() } });
    const tools = [{ functionDeclarations: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: { type: "OBJECT", properties: { text: { type: "STRING", description: "Text to echo." } }, required: ["text"] } }] }];
    return {
        contents: [{ role: "user", parts }],
        generationConfig: { maxOutputTokens: MAX_TOKENS },
        ...(step === "tools" ? { tools, toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
        ...(step === "forced" ? { tools, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [TOOL_NAME] } } } : {}),
    };
}

async function readSse(body: ReadableStream<Uint8Array>, onData: (json: Record<string, unknown>) => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        try { onData(record(JSON.parse(payload))); } catch { /* keep-alive or partial frame */ }
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(handle);
    }
    handle(buffer);
}

async function exchange(target: ProbeTarget, step: ProbeStepName, options: ProbeOptions, onFirstAnswer: () => void): Promise<Exchange> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(options.timeouts?.[step] ?? DEFAULT_TIMEOUTS[step]);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const gemini = target.provider.kind === "gemini";
    const url = gemini
        ? `${GEMINI_API}/models/${encodeURIComponent(target.modelId)}:streamGenerateContent?alt=sse`
        : `${target.provider.baseUrl}/chat/completions`;
    const headers: Record<string, string> = gemini
        ? { "x-goog-api-key": target.apiKey, "Content-Type": "application/json", Accept: "text/event-stream" }
        : { Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream", ...target.provider.extraHeaders };
    const result: Exchange = { httpStatus: null, text: "", reasoning: "", calls: [], error: null, timedOut: false, transport: false, ms: 0 };
    const started = performance.now();
    const calls = new Map<number, { name: string; args: string }>();
    try {
        const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(gemini ? geminiBody(step) : openAiBody(target, step)), signal, cache: "no-store" });
        result.httpStatus = response.status;
        if (!response.ok || !response.body) {
            result.error = errorDetail(await response.text().catch(() => ""), response.status);
            return result;
        }
        await readSse(response.body, (json) => {
            const error = record(json.error);
            if (json.error !== undefined) {
                const code = typeof error.code === "number" ? error.code : null;
                if (code !== null && code >= 100 && code <= 599) result.httpStatus = code;
                result.error = (typeof error.message === "string" ? error.message : "Stream error.").slice(0, DETAIL_MAX);
                return;
            }
            if (gemini) {
                const parts = record(record((json.candidates as unknown[] | undefined)?.[0]).content).parts;
                for (const part of Array.isArray(parts) ? parts.map(record) : []) {
                    const call = record(part.functionCall);
                    if (typeof call.name === "string") calls.set(calls.size, { name: call.name, args: JSON.stringify(call.args ?? {}) });
                    else if (typeof part.text === "string") {
                        if (part.thought === true) result.reasoning += part.text;
                        else { if (part.text) onFirstAnswer(); result.text += part.text; }
                    }
                }
                return;
            }
            const delta = record(record((json.choices as unknown[] | undefined)?.[0]).delta);
            if (typeof delta.content === "string") { if (delta.content) onFirstAnswer(); result.text += delta.content; }
            if (typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content;
            if (typeof delta.reasoning === "string") result.reasoning += delta.reasoning;
            if (Array.isArray(delta.tool_calls)) {
                for (const raw of delta.tool_calls.map(record)) {
                    const index = typeof raw.index === "number" ? raw.index : 0;
                    const fn = record(raw.function);
                    const current = calls.get(index) ?? { name: "", args: "" };
                    if (typeof fn.name === "string" && fn.name) current.name = fn.name;
                    if (typeof fn.arguments === "string") current.args += fn.arguments;
                    calls.set(index, current);
                }
            }
        });
    } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || (name === "AbortError" && timeout.aborted)) result.timedOut = true;
        else result.transport = true;
        result.error = result.timedOut ? "Timed out." : name === "AbortError" ? "Cancelled." : "Request failed before a response.";
    } finally {
        result.ms = Math.round(performance.now() - started);
        result.calls = [...calls.values()].filter((call) => call.name);
    }
    return result;
}

function isTransient(result: Exchange): boolean {
    return result.timedOut || result.transport || (result.httpStatus !== null && TRANSIENT_HTTP.has(result.httpStatus));
}

function echoCalled(result: Exchange): boolean {
    return result.calls.some((call) => {
        if (call.name !== TOOL_NAME) return false;
        try {
            const args: unknown = JSON.parse(call.args || "{}");
            return args !== null && typeof args === "object" && !Array.isArray(args);
        } catch {
            return false;
        }
    });
}

function judge(step: ProbeStepName, result: Exchange): ProbeOutcome {
    if (isTransient(result)) return "transient";
    if (result.httpStatus !== 200 || result.error) return "fail";
    if (step === "chat") return (result.text.trim() || result.reasoning.trim() || result.calls.length) ? "pass" : "fail";
    if (step === "tools" || step === "forced") return echoCalled(result) ? "pass" : "fail";
    const answer = result.text.trim() || result.reasoning;
    return COLOUR_WORD.test(answer) ? "pass" : "fail";
}

function describe(step: ProbeStepName, outcome: ProbeOutcome, result: Exchange): string | null {
    if (result.error) return result.error;
    if (outcome === "pass") return null;
    if (step === "chat") return "Empty answer.";
    if (step === "vision") return `Answered "${result.text.trim().slice(0, 40)}" instead of the colour.`;
    return result.calls.length ? `Called ${result.calls[0].name} instead.` : "Answered in text instead of calling the tool.";
}

async function runStep(target: ProbeTarget, step: ProbeStepName, options: ProbeOptions): Promise<{ step: ProbeStep; httpStatus: number | null }> {
    const observation = beginModelObservation({ providerId: target.provider.id, modelId: target.modelId, purpose: "probe" });
    const result = await exchange(target, step, options, () => observation.firstAnswer());
    const outcome = judge(step, result);
    if (result.httpStatus === 200 && !result.error) observation.capability("streaming");
    if (result.calls.length) observation.capability("tools");
    if (step === "vision" && outcome === "pass") observation.capability("vision");
    if (result.httpStatus === 200 && !result.error) observation.finish();
    else observation.finish({ error: result.timedOut ? { name: "TimeoutError" } : result.transport ? { name: "TypeError" } : { status: result.httpStatus } });
    return { step: { outcome, httpStatus: result.httpStatus, ms: result.ms, detail: describe(step, outcome, result) }, httpStatus: result.httpStatus };
}

const SKIPPED: ProbeStep = { outcome: "skipped", httpStatus: null, ms: null, detail: null };

/** Chat, automatic tool call, forced tool call, then an image question. Stops at the first hard or transient failure. */
export async function probeModel(target: ProbeTarget, options: ProbeOptions = {}): Promise<ProbeResult> {
    const steps: Record<ProbeStepName, ProbeStep> = { chat: SKIPPED, tools: SKIPPED, forced: SKIPPED, vision: SKIPPED };
    const done = (status: ProbeResult["status"], retired = false): ProbeResult => {
        const known = (name: ProbeStepName) => steps[name].outcome === "pass" ? true : steps[name].outcome === "fail" ? false : null;
        return {
            status, retired,
            chatMs: steps.chat.outcome === "pass" ? steps.chat.ms : null,
            supportsTools: known("tools"),
            supportsSearch: steps.tools.outcome === "fail" ? false : known("forced"),
            supportsVision: known("vision"),
            steps,
        };
    };

    const chat = await runStep(target, "chat", options);
    steps.chat = chat.step;
    if (chat.step.outcome === "transient") return done("inconclusive");
    if (chat.step.outcome === "fail") return done("failed", chat.httpStatus === 410);

    steps.tools = (await runStep(target, "tools", options)).step;
    if (steps.tools.outcome === "transient") return done("inconclusive");
    if (steps.tools.outcome === "pass") {
        steps.forced = (await runStep(target, "forced", options)).step;
        if (steps.forced.outcome === "transient") return done("inconclusive");
    }
    if (target.checkVision) {
        steps.vision = (await runStep(target, "vision", options)).step;
        if (steps.vision.outcome === "transient") return done("inconclusive");
    }
    return done("passed");
}
