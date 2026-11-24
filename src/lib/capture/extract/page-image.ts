import { imageMime, type PageImage } from "@/lib/ai/media/requests";
import { PAGE_IMAGE_BODY_LIMIT } from "@/lib/http/limits";
import { parseOutputToMarkdown } from "./parse-markdown";
import { tidyMarkdown } from "./text";

// V8 F2: one photo or rendered page to Markdown. The parse model reads text and tables; a picture with little or no
// text gets a short description from an approved free vision chat model instead.
export const PAGE_IMAGE_MAX_BYTES = PAGE_IMAGE_BODY_LIMIT;
export const MIN_PARSED_CHARS = 40;
export const PAGE_PARSE_TOKENS = 4096;
// Parse and caption together stay inside the Capture page's 60 s request timeout.
const PARSE_TIMEOUT_MS = 30_000;
const CAPTION_TIMEOUT_MS = 25_000;
const CAPTION_SYSTEM = "You describe photos for a private notes app. Plain text only.";
const CAPTION_PROMPT = "Describe this image in two plain sentences: first what it shows, then one notable detail such as a place, an object or any visible writing. Do not guess who people are.";

export interface PageReader { label: string; read(page: PageImage, signal?: AbortSignal): Promise<string> }
export interface ReadPageDeps {
    parser(freeOnly: boolean): Promise<PageReader | null>;
    captioner(freeOnly: boolean): Promise<PageReader | null>;
}
export type PageRead =
    | { method: "parse" | "caption"; markdown: string; model: string }
    | { method: "none"; markdown: ""; model: null; failures: string[] };

/** PNG or JPEG by their bytes; the parse model takes nothing else. */
export function pageImageMime(bytes: Uint8Array): PageImage["mimeType"] | null {
    const mime = imageMime(bytes);
    return mime === "image/png" || mime === "image/jpeg" ? mime : null;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export async function readPageImage(page: PageImage, options: { freeOnly: boolean; signal?: AbortSignal; deps?: ReadPageDeps }): Promise<PageRead> {
    const deps = options.deps ?? pageReaders;
    const failures: string[] = [];
    let parsed: { markdown: string; model: string } | null = null;
    const parser = await deps.parser(options.freeOnly);
    if (parser) {
        try {
            const markdown = tidyMarkdown(parseOutputToMarkdown(await parser.read(page, options.signal)));
            if (markdown.length >= MIN_PARSED_CHARS) return { method: "parse", markdown, model: parser.label };
            parsed = { markdown, model: parser.label };
        } catch (error) {
            if (options.signal?.aborted) throw error;
            failures.push(`${parser.label}: ${reason(error)}`);
        }
    }
    const captioner = await deps.captioner(options.freeOnly);
    if (captioner) {
        try {
            const caption = tidyMarkdown(await captioner.read(page, options.signal));
            if (caption) return { method: "caption", markdown: parsed?.markdown ? `${caption}\n\n${parsed.markdown}` : caption, model: captioner.label };
        } catch (error) {
            if (options.signal?.aborted) throw error;
            failures.push(`${captioner.label}: ${reason(error)}`);
        }
    }
    if (parsed) return { method: "parse", ...parsed };
    return { method: "none", markdown: "", model: null, failures };
}

const withTimeout = (ms: number, signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/** The approved parse model, and the first free vision chat model for captions. */
export const pageReaders: ReadPageDeps = {
    async parser(freeOnly) {
        const [{ resolveModelOfKind }, { requestParse }, { observedMediaCall }] = await Promise.all([
            import("@/lib/ai/media/resolve"), import("@/lib/ai/media/requests"), import("@/lib/ai/media/observed"),
        ]);
        const route = await resolveModelOfKind("parse", { freeOnly });
        if (!route) return null;
        return {
            label: route.row.label,
            async read(page, signal) {
                const result = await observedMediaCall(route, "parse", () => requestParse(route, page, PAGE_PARSE_TOKENS, { timeoutMs: PARSE_TIMEOUT_MS, signal }));
                if (!result.ok) throw new Error(result.error);
                return result.value;
            },
        };
    },
    async captioner(freeOnly) {
        const [{ currentRoster, rankForPurpose }, { providers, resolveEmbedding }, { openaiCompatChat }] = await Promise.all([
            import("@/lib/ai/models/roster"), import("@/lib/ai/providers"), import("@/lib/ai/openai-compat"),
        ]);
        // Free, approved, not failing and not Gemini, as for agent workers.
        const entry = rankForPurpose(currentRoster({ freeOnly, paidOrchestrator: false, unattended: false }), "vision", { tools: false, vision: true })[0];
        const provider = entry && providers().find((candidate) => candidate.id === entry.providerId);
        const model = provider?.chatModels.find((candidate) => candidate.id === entry.modelId);
        if (!provider || !model) return null;
        return {
            label: model.label,
            read: (page, signal) => openaiCompatChat({
                purpose: "extraction", provider, model: { ...model, supportsTools: false }, systemText: CAPTION_SYSTEM, userText: CAPTION_PROMPT,
                imageBase64: Buffer.from(page.bytes).toString("base64"), imageMimeType: page.mimeType, embRef: resolveEmbedding(),
                genParams: { maxTokens: 600 }, signal: withTimeout(CAPTION_TIMEOUT_MS, signal),
            }),
        };
    },
};

/** readPageImage for a route: personal data under the owner's Free only setting, with the calls stored as observations. */
export async function readPageImageRecorded(page: PageImage, options: { freeOnly: boolean; signal?: AbortSignal }): Promise<PageRead> {
    const [observations, { persistModelObservations }] = await Promise.all([import("@/lib/ai/model-observations"), import("@/lib/ai/model-health")]);
    const { value, observations: recorded } = await observations.collectModelObservations(async () => {
        observations.configureModelDataPolicy(options.freeOnly);
        return readPageImage(page, options);
    }, ["personal"]);
    await persistModelObservations(recorded).catch((error) => console.error("[Capture] Could not store page reading observations:", error instanceof Error ? error.message : error));
    return value;
}
