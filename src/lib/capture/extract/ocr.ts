import { CaptureError } from "../service";
import type { OcrTier } from "../types";
import { tidyMarkdown } from "./text";
import { providerKeyOrEnv } from "@/lib/ai/provider-keys/snapshot";

export const OCR_MODEL = "gemini-3.8-flash";
const OCR_TIMEOUT_MS = 8 * 60_000;
const NO_TEXT = "[no text]";
const prompt = (what: string) => `Transcribe all readable text in this ${what} as Markdown, in reading order. Keep headings, lists and tables. `
    + `Do not summarise, translate or add commentary. Write [unreadable] where text cannot be read. If the ${what} has no readable text at all, reply with exactly ${NO_TEXT}`;
export type OcrMime = "application/pdf" | "image/jpeg";

function ocrKey(tier: OcrTier): string | undefined {
    return tier === "paid" ? providerKeyOrEnv("gemini", "GEMINI_API_KEY") : providerKeyOrEnv("gemini-free", "GEMINI_FREE_API_KEY");
}

export function ocrTiers(freeOnly: boolean): Record<OcrTier, boolean> {
    return { free: !!ocrKey("free"), paid: !freeOnly && !!ocrKey("paid") };
}

export interface OcrResponse { text?: string; candidates?: { finishReason?: unknown }[] }
export type OcrGenerate = (bytes: Uint8Array, tier: OcrTier, mimeType: OcrMime) => Promise<OcrResponse>;

async function geminiGenerate(bytes: Uint8Array, tier: OcrTier, freeOnly: boolean, mimeType: OcrMime): Promise<OcrResponse> {
    const key = ocrKey(tier);
    if (!key) throw new CaptureError(`The ${tier} Gemini key is not set.`, 400);
    const [{ geminiClient }, { ThinkingLevel }, observations, { persistModelObservations }] = await Promise.all([
        import("@/lib/gemini"), import("@google/genai"), import("@/lib/ai/model-observations"), import("@/lib/ai/model-health"),
    ]);
    const client = observations.observeGeminiClient(geminiClient(key), { providerId: tier === "paid" ? "gemini" : "gemini-free", purpose: "extraction" });
    const { value, observations: recorded } = await observations.collectModelObservations(async () => {
        observations.configureModelDataPolicy(freeOnly);
        return client.models.generateContent({
            model: OCR_MODEL,
            contents: [{ role: "user", parts: [{ text: prompt(mimeType === "application/pdf" ? "PDF" : "image") }, { inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") } }] }],
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
    if (name === "TimeoutError" || name === "AbortError") return new CaptureError("Gemini took too long to read the file. Try again.", 504);
    return error;
}

/** A PDF by default; Capture photos are JPEG. */
export async function transcribePdf(bytes: Uint8Array, tier: OcrTier, options: { freeOnly: boolean; generate?: OcrGenerate; mimeType?: OcrMime }): Promise<{ text: string; truncated: boolean }> {
    if (!ocrTiers(options.freeOnly)[tier] && !options.generate) throw new CaptureError(tier === "paid" ? "Paid Gemini is unavailable: Free only is on or the key is not set." : "The free Gemini key is not set.", 403);
    const mimeType = options.mimeType ?? "application/pdf";
    const response = await (options.generate ? options.generate(bytes, tier, mimeType) : geminiGenerate(bytes, tier, options.freeOnly, mimeType)).catch((error: unknown) => { throw geminiFailure(error, tier); });
    // Gemini reports a token-budget stop without an error.
    const truncated = String(response.candidates?.[0]?.finishReason) === "MAX_TOKENS";
    const text = tidyMarkdown(response.text ?? "");
    return { text: text === NO_TEXT ? "" : text, truncated };
}
