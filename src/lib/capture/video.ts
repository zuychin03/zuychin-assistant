import { catalogueSnapshot, type CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { currentRoster, type RosterEntry } from "@/lib/ai/models/roster";
import { getProvider, getProviderApiKey, type ProviderConfig } from "@/lib/ai/providers";
import { mediaPost, type MediaCallOptions, type MediaResult } from "@/lib/ai/media/requests";
import { observedMediaCall } from "@/lib/ai/media/observed";
import { collectModelObservations, configureModelDataPolicy } from "@/lib/ai/model-observations";
import { persistModelObservations } from "@/lib/ai/model-health";
import { VIDEO_BODY_LIMIT } from "@/lib/http/limits";
import { CAPTURE_TEXT_MAX } from "@/lib/voice/recording-limits";

// V8 F4: a short video to notes through a chat model that passed the catalogue's video step (trait `video`). The video
// goes inline as base64 and is never kept (Decision 19).

export const VIDEO_WEB_MAX_BYTES = VIDEO_BODY_LIMIT;
/** getFile serves bot downloads up to 20 MB. */
export const VIDEO_TELEGRAM_MAX_BYTES = 20 * 1024 * 1024;
// Gemini takes inline data in a request of up to 20 MB, and base64 adds a third.
const GEMINI_INLINE_MAX = 14 * 1024 * 1024;
export const VIDEO_TOTAL_MS = 240_000;
const ATTEMPT_MS = 180_000;
const MAX_ATTEMPTS = 2;
// Room for a few minutes of transcript after the summary.
const MAX_OUTPUT_TOKENS = 8192;
const TITLE_MAX = 120;
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

export type VideoMime = "video/mp4" | "video/quicktime" | "video/webm";
export type VideoFailure = "unsupported" | "no_model" | "too_large" | "busy" | "timeout" | "failed";
export type VideoNotes = { ok: true; title: string; text: string; model: string; speech: boolean } | { ok: false; reason: VideoFailure; detail?: string };

export interface VideoModel {
    provider: Pick<ProviderConfig, "id" | "kind" | "baseUrl" | "extraHeaders">;
    modelId: string;
    apiKey: string;
    label: string;
    free: boolean;
    /** Heard the probe clip's sentence, so its notes can carry a transcript. */
    speech: boolean;
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** By the container's first bytes: ISO media ("ftyp"; QuickTime when the brand is "qt  ") or WebM. */
export function videoMime(bytes: Uint8Array): VideoMime | null {
    if (bytes.length >= 12 && ascii(bytes.subarray(4, 8)) === "ftyp") return ascii(bytes.subarray(8, 12)) === "qt  " ? "video/quicktime" : "video/mp4";
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
    return null;
}

/** Models this request may use whose catalogue row passed the video step: free first, then those that hear speech, then faster. */
export function rankVideoEntries(entries: readonly RosterEntry[], rows: readonly CatalogueRow[]): { entry: RosterEntry; speech: boolean }[] {
    const byKey = new Map(rows.map((row) => [`${row.providerId}::${row.modelId}`, row]));
    const ranked = entries.flatMap((entry) => {
        const row = byKey.get(`${entry.providerId}::${entry.modelId}`);
        if (!entry.hintEligible || entry.status === "failing" || row?.probeStatus !== "passed" || row.traits?.video !== true) return [];
        return [{ entry, speech: row.traits.videoSpeech === true, ms: row.probeChatMs ?? Number.MAX_SAFE_INTEGER }];
    });
    ranked.sort((a, b) => Number(b.entry.free) - Number(a.entry.free) || Number(b.speech) - Number(a.speech) || a.ms - b.ms || a.entry.label.localeCompare(b.entry.label));
    return ranked.map(({ entry, speech }) => ({ entry, speech }));
}

/** The video models a request under this Free only setting may use, best first. */
export function videoModels(freeOnly: boolean): VideoModel[] {
    const ranked = rankVideoEntries(currentRoster({ freeOnly, paidOrchestrator: !freeOnly, unattended: false }), catalogueSnapshot().rows);
    return ranked.flatMap(({ entry, speech }) => {
        const provider = getProvider(entry.providerId);
        const apiKey = provider ? getProviderApiKey(provider) : undefined;
        return provider && apiKey ? [{ provider, modelId: entry.modelId, apiKey, label: entry.label, free: entry.free, speech }] : [];
    });
}

const inlineLimit = (model: VideoModel) => model.provider.kind === "gemini" ? GEMINI_INLINE_MAX : VIDEO_TELEGRAM_MAX_BYTES;

export function videoNotesPrompt(speech: boolean): string {
    return [
        "You turn a video into notes for a private notes app. Make notes from this video and reply in exactly this form:",
        "",
        "Title: <what the video is about, at most 10 words>",
        "",
        "## Summary",
        "<two to four sentences on what the video shows and says>",
        "",
        "## Key points",
        "- <three to eight points: decisions, dates, figures, steps, and any important text shown on screen>",
        ...(speech ? ["", "## Transcript", "<every word spoken, in order; write \"No speech.\" when nobody speaks>"] : []),
        "",
        "Write in the video's language. Use only what the video shows or says, and do not guess who people are.",
    ].join("\n");
}

/** The model's notes as a title and Markdown body; null when nothing but a title came back. */
export function parseVideoNotes(raw: string, fallbackTitle: string): { title: string; text: string } | null {
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\r\n/g, "\n").trim()
        .replace(/^```(?:markdown|md)?\n/i, "").replace(/\n```$/, "").trim();
    const match = /^[ \t]*(?:\*\*)?Title:(?:\*\*)?[ \t]*(.+)$/im.exec(clean);
    const title = match?.[1].replace(/[*#_`]+/g, "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || fallbackTitle;
    const text = (match ? clean.slice(0, match.index) + clean.slice(match.index + match[0].length) : clean).trim();
    return text ? { title, text: text.slice(0, CAPTURE_TEXT_MAX) } : null;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// The app's thinking-off switches (openai-compat.ts), plus NIM's: Nemotron 3 Nano Omni thought its way past 4,096
// tokens on a 90 s video and returned no notes, and without thinking took 29 s instead of 58 s (25/11/2026).
function thinkingOff(providerId: string): Record<string, unknown> {
    if (providerId === "nvidia-nim") return { chat_template_kwargs: { enable_thinking: false } };
    if (providerId === "kilo") return { reasoning: { enabled: false } };
    if (providerId === "deepseek") return { thinking: { type: "disabled" } };
    return {};
}

function answerText(json: unknown, gemini: boolean): string {
    if (gemini) {
        const parts = record(record((record(json).candidates as unknown[] | undefined)?.[0]).content).parts;
        return (Array.isArray(parts) ? parts.map(record) : []).filter((part) => part.thought !== true).map((part) => typeof part.text === "string" ? part.text : "").join("");
    }
    const content = record(record((record(json).choices as unknown[] | undefined)?.[0]).message).content;
    if (typeof content === "string") return content;
    return Array.isArray(content) ? content.map(record).map((part) => typeof part.text === "string" ? part.text : "").join("") : "";
}

/** One request: the prompt and the video inline, shaped as the probe sent the clip (video_url, or Gemini inlineData). */
export async function requestVideoNotes(model: VideoModel, video: { base64: string; mimeType: VideoMime }, prompt: string, options: MediaCallOptions): Promise<MediaResult<string>> {
    const gemini = model.provider.kind === "gemini";
    const url = gemini ? `${GEMINI_API}/models/${encodeURIComponent(model.modelId)}:generateContent` : `${model.provider.baseUrl}/chat/completions`;
    const headers: Record<string, string> = gemini ? { "x-goog-api-key": model.apiKey } : { Authorization: `Bearer ${model.apiKey}`, ...model.provider.extraHeaders };
    const body = gemini
        ? { contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: video.mimeType, data: video.base64 } }] }], generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS } }
        : {
            model: model.modelId, max_tokens: MAX_OUTPUT_TOKENS, stream: false, ...thinkingOff(model.provider.id),
            messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "video_url", video_url: { url: `data:${video.mimeType};base64,${video.base64}` } }] }],
        };
    const result = await mediaPost(url, JSON.stringify(body), headers, options);
    if (!result.ok) return result;
    const text = answerText(result.json, gemini);
    if (!text.trim()) return { ok: false, status: result.status, ms: result.ms, error: "The model returned no notes.", transient: false, timedOut: false, retiredAt: null };
    return { ok: true, value: text, status: result.status, ms: result.ms };
}

const NO_TRANSCRIPT = "_No transcript: the model that read this video cannot hear its speech._";

/**
 * The best video model first, then one more if it fails, within one deadline. Each call is a model observation, so
 * inside a collector with a policy the data rule refuses a route before anything is sent.
 */
export async function videoToNotes(video: { bytes: Uint8Array; title: string }, options: {
    freeOnly: boolean; signal?: AbortSignal; models?: readonly VideoModel[]; fetchImpl?: typeof fetch; totalMs?: number;
}): Promise<VideoNotes> {
    const mimeType = videoMime(video.bytes);
    if (!mimeType) return { ok: false, reason: "unsupported" };
    const models = options.models ?? videoModels(options.freeOnly);
    if (!models.length) return { ok: false, reason: "no_model" };
    const fitting = models.filter((model) => video.bytes.byteLength <= inlineLimit(model));
    if (!fitting.length) return { ok: false, reason: "too_large" };
    const base64 = Buffer.from(video.bytes).toString("base64");
    const totalMs = options.totalMs ?? VIDEO_TOTAL_MS;
    const deadline = AbortSignal.timeout(totalMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const started = performance.now();
    let last: VideoNotes = { ok: false, reason: "failed" };
    for (const model of fitting.slice(0, MAX_ATTEMPTS)) {
        const remaining = Math.floor(totalMs - (performance.now() - started));
        if (signal.aborted || remaining < 1000) break;
        try {
            const result = await observedMediaCall(model, "summary", () => requestVideoNotes(model, { base64, mimeType }, videoNotesPrompt(model.speech),
                { signal, timeoutMs: Math.min(ATTEMPT_MS, remaining), fetchImpl: options.fetchImpl }));
            if (result.ok) {
                const notes = parseVideoNotes(result.value, video.title);
                if (notes) return { ok: true, title: notes.title, text: model.speech ? notes.text : `${notes.text}\n\n${NO_TRANSCRIPT}`, model: model.label, speech: model.speech };
                last = { ok: false, reason: "failed", detail: `${model.label} returned no notes.` };
            } else {
                last = { ok: false, reason: result.timedOut ? "timeout" : result.status === 429 ? "busy" : "failed", detail: `${model.label}: ${result.error}` };
            }
        } catch (error) {
            if (options.signal?.aborted) throw error;
            if (deadline.aborted) return { ok: false, reason: "timeout" };
            last = { ok: false, reason: "failed", detail: `${model.label}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
        }
    }
    return deadline.aborted ? { ok: false, reason: "timeout" } : last;
}

/** videoToNotes as personal data under the owner's Free only setting, with the calls stored as model observations. */
export async function videoToNotesRecorded(video: { bytes: Uint8Array; title: string }, options: { freeOnly: boolean; signal?: AbortSignal }): Promise<VideoNotes> {
    const { value, observations } = await collectModelObservations(async () => {
        configureModelDataPolicy(options.freeOnly);
        return videoToNotes(video, options);
    }, ["personal"]);
    await persistModelObservations(observations).catch((error) => console.error("[Capture] Could not store video observations:", error instanceof Error ? error.message : error));
    return value;
}

export function videoFailureText(reason: VideoFailure): string {
    switch (reason) {
        case "unsupported": return "That file is not a video this app can read. Send an MP4, MOV or WebM video.";
        case "no_model": return "Video summaries are unavailable right now: no approved model can read video.";
        case "too_large": return "That video is too large for the models that can read video right now. Send a shorter clip.";
        case "busy": return "The video model is busy. Try again in a minute.";
        case "timeout": return "Summarising the video took too long. Try a shorter clip.";
        case "failed": return "The video could not be summarised. Try again, or send a shorter clip.";
    }
}

/** A fallback title from the file name, else the day it was sent (Sydney time). */
export function videoTitle(input: { fileName?: unknown; sentAt?: unknown }): string {
    const named = typeof input.fileName === "string" ? input.fileName.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() : "";
    if (named && !/^(video|blob|file)$/i.test(named)) return named.slice(0, TITLE_MAX);
    const sent = typeof input.sentAt === "number" ? new Date(input.sentAt * 1000) : new Date();
    return `Video ${sent.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "2-digit", year: "numeric" })}`;
}
