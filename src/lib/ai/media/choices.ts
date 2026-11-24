import { MEDIA_KINDS, type MediaKind } from "@/lib/ai/catalogue/sources";

// The owner's model choice per V8 kind from /admin#models, kept in cron_state. No choice means the first usable row.

export const MEDIA_CHOICES_KEY = "media_models";
const TTL_MS = 60_000;

export interface MediaChoice { providerId: string; modelId: string }
export type MediaChoices = Partial<Record<MediaKind, MediaChoice>>;

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/;

export function parseMediaChoice(raw: unknown): MediaChoice | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const { providerId, modelId } = raw as Record<string, unknown>;
    return typeof providerId === "string" && ID.test(providerId) && typeof modelId === "string" && ID.test(modelId) ? { providerId, modelId } : null;
}

export function parseMediaChoices(raw: unknown): MediaChoices {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const out: MediaChoices = {};
    for (const kind of MEDIA_KINDS) {
        const choice = parseMediaChoice(value[kind]);
        if (choice) out[kind] = choice;
    }
    return out;
}

const KEY = Symbol.for("zuychin.assistant.mediaChoices");

function cache(): { value: MediaChoices; loadedAt: number } {
    const holder = globalThis as typeof globalThis & { [KEY]?: { value: MediaChoices; loadedAt: number } };
    holder[KEY] ??= { value: {}, loadedAt: 0 };
    return holder[KEY];
}

export function cachedMediaChoices(): MediaChoices {
    return cache().value;
}

/** Cached for a minute. A failed read keeps the last known choices. */
export async function readMediaChoices(force = false): Promise<MediaChoices> {
    const current = cache();
    if (!force && current.loadedAt && Date.now() - current.loadedAt < TTL_MS) return current.value;
    try {
        const { getCronState } = await import("@/lib/cron-state");
        current.value = parseMediaChoices(await getCronState<Record<string, unknown>>(MEDIA_CHOICES_KEY));
    } catch (error) {
        console.error("[MediaChoices] Read failed:", error instanceof Error ? error.message : error);
    }
    current.loadedAt = Date.now();
    return current.value;
}

/** Null clears the kind's choice, so the first usable row serves it. */
export async function saveMediaChoice(kind: MediaKind, choice: MediaChoice | null): Promise<MediaChoices> {
    const { setCronState } = await import("@/lib/cron-state");
    const current = cache();
    const next: MediaChoices = { ...await readMediaChoices(true) };
    if (choice) next[kind] = choice;
    else delete next[kind];
    await setCronState(MEDIA_CHOICES_KEY, { ...next });
    current.value = next;
    current.loadedAt = Date.now();
    return next;
}

export function setMediaChoicesForTests(value: MediaChoices): void {
    const current = cache();
    current.value = value;
    current.loadedAt = Date.now();
}
