// Owner-wide speech choices from /admin#models, kept in cron_state. Voice preferences have no Settings control,
// so the backup voice and the transcription order are set on the dashboard.

export const SPEECH_BACKUP_KEY = "speech_backup";
export const TRANSCRIPTION_KEY = "transcription";
const TTL_MS = 60_000;

export interface SpeechBackupChoice {
    providerId: string;
    modelId: string;
    voice: string | null;
}

/** local: on-box only (today). Raw audio to the chat model stays the last step in every order. */
export const TRANSCRIPTION_ORDERS = ["local", "local-first", "api-first", "api"] as const;
export type TranscriptionOrder = typeof TRANSCRIPTION_ORDERS[number];

export interface TranscriptionChoice {
    order: TranscriptionOrder;
    providerId: string | null;
    modelId: string | null;
}

export const DEFAULT_TRANSCRIPTION: TranscriptionChoice = { order: "local", providerId: null, modelId: null };

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseSpeechBackup(raw: unknown): SpeechBackupChoice | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const providerId = text(value.providerId), modelId = text(value.modelId);
    return providerId && modelId ? { providerId, modelId, voice: text(value.voice) } : null;
}

/** An API order without a chosen model falls back to on-box only. */
export function parseTranscription(raw: unknown): TranscriptionChoice {
    if (!raw || typeof raw !== "object") return DEFAULT_TRANSCRIPTION;
    const value = raw as Record<string, unknown>;
    const order = TRANSCRIPTION_ORDERS.find((entry) => entry === value.order) ?? "local";
    const providerId = text(value.providerId), modelId = text(value.modelId);
    if (order === "local" || !providerId || !modelId) return { ...DEFAULT_TRANSCRIPTION, providerId, modelId };
    return { order, providerId, modelId };
}

export interface VoiceChoices {
    speech: SpeechBackupChoice | null;
    transcription: TranscriptionChoice;
}

const KEY = Symbol.for("zuychin.assistant.voiceChoices");

function cache(): { value: VoiceChoices; loadedAt: number } {
    const holder = globalThis as typeof globalThis & { [KEY]?: { value: VoiceChoices; loadedAt: number } };
    holder[KEY] ??= { value: { speech: null, transcription: DEFAULT_TRANSCRIPTION }, loadedAt: 0 };
    return holder[KEY];
}

export function cachedVoiceChoices(): VoiceChoices {
    return cache().value;
}

/** Reads both choices, cached for a minute. A failed read keeps the last known choices. */
export async function readVoiceChoices(force = false): Promise<VoiceChoices> {
    const current = cache();
    if (!force && current.loadedAt && Date.now() - current.loadedAt < TTL_MS) return current.value;
    try {
        const { getCronState } = await import("@/lib/cron-state");
        const [speech, transcription] = await Promise.all([
            getCronState<Record<string, unknown>>(SPEECH_BACKUP_KEY), getCronState<Record<string, unknown>>(TRANSCRIPTION_KEY),
        ]);
        current.value = { speech: parseSpeechBackup(speech), transcription: parseTranscription(transcription) };
    } catch (error) {
        console.error("[VoiceChoices] Read failed:", error instanceof Error ? error.message : error);
    }
    current.loadedAt = Date.now();
    return current.value;
}

export async function saveVoiceChoices(next: { speech?: SpeechBackupChoice | null; transcription?: TranscriptionChoice }): Promise<VoiceChoices> {
    const { setCronState } = await import("@/lib/cron-state");
    const current = cache();
    if (next.speech !== undefined) await setCronState(SPEECH_BACKUP_KEY, next.speech ? { ...next.speech } : {});
    if (next.transcription !== undefined) await setCronState(TRANSCRIPTION_KEY, { ...next.transcription });
    current.value = {
        speech: next.speech !== undefined ? next.speech : current.value.speech,
        transcription: next.transcription ?? current.value.transcription,
    };
    current.loadedAt = Date.now();
    return current.value;
}

/** For offline tests. */
export function setVoiceChoicesForTests(value: VoiceChoices): void {
    const current = cache();
    current.value = value;
    current.loadedAt = Date.now();
}
