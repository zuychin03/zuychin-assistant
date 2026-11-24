import { rowKind, type CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import type { SpeechBackupChoice, TranscriptionChoice } from "@/lib/ai/voice-choices";
import { geminiTtsModel } from "@/lib/ai/speech-model";

/** The knowledge partition and the route that writes it. `modelId` is the id sent to the API (native size). */
export interface ActiveEmbedding {
    partitionId: string;
    providerId: string;
    modelId: string;
}

export interface InUse {
    embedding: ActiveEmbedding | null;
    /** `provider::model` keys tested on every run when free, and watched for retirement. */
    keys: ReadonlySet<string>;
}

export const DEFAULT_SPEECH_MODEL = () => geminiTtsModel();

/** Every non-chat route the app uses now: the knowledge model, its approved same-space backups, the voice and the transcription model. */
export function inUseRoutes(input: { embedding: ActiveEmbedding | null; speech: SpeechBackupChoice | null; transcription: TranscriptionChoice }, rows: readonly CatalogueRow[]): InUse {
    const keys = new Set<string>();
    const { embedding, speech, transcription } = input;
    if (embedding) {
        keys.add(`${embedding.providerId}::${embedding.modelId}`);
        for (const row of rows) {
            if (rowKind(row) === "embedding" && row.approvedAt !== null && row.spaceOf === embedding.modelId) keys.add(`${row.providerId}::${row.modelId}`);
        }
    }
    if (speech) keys.add(`${speech.providerId}::${speech.modelId}`);
    else for (const providerId of ["gemini-free", "gemini"]) keys.add(`${providerId}::${DEFAULT_SPEECH_MODEL()}`);
    if (transcription.order !== "local" && transcription.providerId && transcription.modelId) keys.add(`${transcription.providerId}::${transcription.modelId}`);
    return { embedding, keys };
}
