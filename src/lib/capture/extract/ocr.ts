import { CaptureError } from "../service";
import type { OcrTier } from "../types";
import { tidyMarkdown } from "./text";

export const OCR_MODEL = "gemini-3.8-flash";
const OCR_TIMEOUT_MS = 8 * 60_000;
const NO_TEXT = "[no text]";
const PROMPT = "Transcribe all readable text in this PDF as Markdown, in reading order. Keep headings, lists and tables. "
    + `Do not summarise, translate or add commentary. Write [unreadable] where text cannot be read. If the PDF has no readable text at all, reply with exactly ${NO_TEXT}`;

export function ocrTiers(freeOnly: boolean): Record<OcrTier, boolean> {
    return { free: !!process.env.GEMINI_FREE_API_KEY, paid: !freeOnly && !!process.env.GEMINI_API_KEY };
}

export interface OcrResponse { text?: string; candidates?: { finishReason?: unknown }[] }
export type OcrGenerate = (bytes: Uint8Array, tier: OcrTier) => Promise<OcrResponse>;

async function geminiGenerate(bytes: Uint8Array, tier: OcrTier, freeOnly: boolean): Promise<OcrResponse> {
    const key = tier === "paid" ? process.env.GEMINI_API_KEY : process.env.GEMINI_FREE_API_KEY;
    if (!key) throw new CaptureError(`The ${tier} Gemini key is not set.`, 400);
    const [{ geminiClient }, { ThinkingLevel }, observations, { persistModelObservations }] = await Promise.all([
        import("@/lib/gemini"), import("@google/genai"), import("@/lib/ai/model-observations"), import("@/lib/ai/model-health"),
    ]);
    const client = observations.observeGeminiClient(geminiClient(key), { providerId: tier === "paid" ? "gemini" : "gemini-free", purpose: "extraction" });
    const { value, observations: recorded } = await observations.collectModelObservations(async () => {
        observations.configureModelDataPolicy(freeOnly);
        return client.models.generateContent({
            model: OCR_MODEL,
            contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType: "application/pdf", data: Buffer.from(bytes).toString("base64") } }] }],
            config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, abortSignal: AbortSignal.timeout(OCR_TIMEOUT_MS) },
        });
    }, ["personal"]);
    await persistModelObservations(recorded).catch((error) => console.error("[Capture] Could not store OCR observations:", error instanceof Error ? error.message : error));
    return value;
}

function geminiFailure(error: unknown, tier: OcrTier): unknown {
    if (error instanceof CaptureError) return error;
    const status = (error as { status?: unknown } | null)?.status, name = (error as { name?: unknown } | null)?.name;
    if (status === 429) return new CaptureError(tier === "free" ? "The free Gemini quota is used up for now. Try again later." : "Gemini is rate limited right now. Try again in a few minutes.", 429);
    if (status === 500 || status === 503) return new CaptureError("Gemini is busy right now. Try again in a few minutes.", 503);
    if (name === "TimeoutError" || name === "AbortError") return new CaptureError("Gemini took too long to read the PDF. Try again.", 504);
    return error;
}

export async function transcribePdf(bytes: Uint8Array, tier: OcrTier, options: { freeOnly: boolean; generate?: OcrGenerate }): Promise<{ text: string; truncated: boolean }> {
    if (!ocrTiers(options.freeOnly)[tier] && !options.generate) throw new CaptureError(tier === "paid" ? "Paid Gemini is unavailable: Free only is on or the key is not set." : "The free Gemini key is not set.", 403);
    const response = await (options.generate ? options.generate(bytes, tier) : geminiGenerate(bytes, tier, options.freeOnly)).catch((error: unknown) => { throw geminiFailure(error, tier); });
    // Gemini reports a token-budget stop without an error.
    const truncated = String(response.candidates?.[0]?.finishReason) === "MAX_TOKENS";
    const text = tidyMarkdown(response.text ?? "");
    return { text: text === NO_TEXT ? "" : text, truncated };
}
