import type { Candidate, GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import type { ObservedGeminiClient } from "@/lib/ai/model-observations";
import { MASK_NOTE, partialStart, type Masker } from "@/lib/ai/privacy/mask";
import { logMasking, maskerFor } from "@/lib/ai/privacy/policy";

// V8 F13 for the Gemini chat paths that take the user's model choice (chat, agent lead, ask_model, council seats).

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function maskPart(part: unknown, masker: Masker): unknown {
    if (typeof part === "string") return masker.mask(part);
    if (!object(part)) return part;
    const value = part as Part;
    return {
        ...value,
        ...(typeof value.text === "string" ? { text: masker.mask(value.text) } : {}),
        ...(value.functionCall ? { functionCall: { ...value.functionCall, args: masker.maskDeep(value.functionCall.args) } } : {}),
        ...(value.functionResponse ? { functionResponse: { ...value.functionResponse, response: masker.maskDeep(value.functionResponse.response) } } : {}),
    };
}

/** A string, a Content, a part, or a list of either. */
function maskContents(value: unknown, masker: Masker): unknown {
    if (Array.isArray(value)) return value.map((item) => maskContents(item, masker));
    if (object(value) && Array.isArray(value.parts)) return { ...value, parts: value.parts.map((part) => maskPart(part, masker)) };
    return maskPart(value, masker);
}

function withNote(instruction: unknown): unknown {
    if (instruction === undefined || instruction === null || instruction === "") return MASK_NOTE;
    if (typeof instruction === "string") return `${instruction}\n\n${MASK_NOTE}`;
    if (Array.isArray(instruction)) return [...instruction, { text: MASK_NOTE }];
    if (object(instruction) && Array.isArray(instruction.parts)) return { ...instruction, parts: [...instruction.parts, { text: MASK_NOTE }] };
    return [instruction, { text: MASK_NOTE }];
}

function maskParams(params: GenerateContentParameters, masker: Masker): GenerateContentParameters {
    const instruction = params.config?.systemInstruction === undefined ? undefined : maskContents(params.config.systemInstruction, masker);
    const contents = maskContents(params.contents, masker) as GenerateContentParameters["contents"];
    if (!masker.size) return params;
    return { ...params, contents, config: { ...params.config, systemInstruction: withNote(instruction) as NonNullable<GenerateContentParameters["config"]>["systemInstruction"] } };
}

const answerText = (candidate: Candidate | undefined) => (candidate?.content?.parts ?? []).map((part) => typeof part.text === "string" && !part.thought ? part.text : "").join("");

/** Search citations are placed by offsets into the text the model wrote, so they move with each restored detail. */
function remapGrounding(candidate: Candidate | undefined, maskedText: string, masker: Masker): void {
    for (const support of candidate?.groundingMetadata?.groundingSupports ?? []) {
        const segment = support.segment;
        if (!segment) continue;
        if (typeof segment.startIndex === "number") segment.startIndex = masker.unmask(maskedText.slice(0, segment.startIndex)).length;
        if (typeof segment.endIndex === "number") segment.endIndex = masker.unmask(maskedText.slice(0, segment.endIndex)).length;
        if (typeof segment.text === "string") segment.text = masker.unmask(segment.text);
    }
}

function restoreCandidates(candidates: Candidate[] | undefined, masker: Masker): void {
    for (const candidate of candidates ?? []) {
        remapGrounding(candidate, answerText(candidate), masker);
        for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === "string") part.text = masker.unmask(part.text);
            if (part.functionCall?.args) part.functionCall.args = masker.unmaskDeep(part.functionCall.args);
        }
    }
}

/** Restores each chunk in place; an unfinished placeholder moves to the next text part, or to one last chunk. */
async function* restoreStream(stream: AsyncGenerator<GenerateContentResponse>, masker: Masker): AsyncGenerator<GenerateContentResponse> {
    let held = "";
    let maskedText = "";
    for await (const chunk of stream) {
        const [first, ...others] = chunk.candidates ?? [];
        restoreCandidates(others, masker);
        const content = first?.content;
        maskedText += answerText(first);
        remapGrounding(first, maskedText, masker);
        if (content?.parts) {
            const kept: Part[] = [];
            for (const part of content.parts) {
                if (part.functionCall?.args) part.functionCall.args = masker.unmaskDeep(part.functionCall.args);
                if (typeof part.text === "string" && !part.thought) {
                    const joined = held + part.text;
                    const cut = partialStart(joined);
                    held = joined.slice(cut);
                    part.text = masker.unmask(joined.slice(0, cut));
                    // A part emptied by holding is dropped unless it carries more than text (a thought signature).
                    if (!part.text && Object.keys(part).every((key) => key === "text")) continue;
                } else if (typeof part.text === "string") {
                    part.text = masker.unmask(part.text);
                }
                kept.push(part);
            }
            content.parts = kept;
        }
        yield chunk;
    }
    if (held) yield { candidates: [{ content: { role: "model", parts: [{ text: masker.unmask(held) }] } }] } as unknown as GenerateContentResponse;
}

/** Masks requests to a route that may train and restores the answers; any other route passes straight through. */
export function maskGeminiClient(client: ObservedGeminiClient, providerId: string): ObservedGeminiClient {
    return { models: {
        async generateContent(params) {
            const masker = maskerFor(providerId, params.model);
            if (!masker) return client.models.generateContent(params);
            const sent = maskParams(params, masker);
            logMasking(providerId, params.model, masker);
            const response = await client.models.generateContent(sent);
            restoreCandidates(response.candidates, masker);
            return response;
        },
        async generateContentStream(params) {
            const masker = maskerFor(providerId, params.model);
            if (!masker) return client.models.generateContentStream(params);
            const sent = maskParams(params, masker);
            logMasking(providerId, params.model, masker);
            return restoreStream(await client.models.generateContentStream(sent), masker);
        },
        embedContent: (params) => client.models.embedContent(params),
    } };
}
