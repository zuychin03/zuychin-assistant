import { catalogueSnapshot } from "@/lib/ai/catalogue/snapshot";
import { DEFAULT_MASK_PREFS, Masker, readMaskPrefs, type MaskPrefs } from "@/lib/ai/privacy/mask";

// V8 F13: which chat routes get masked. Embeddings, rerank and speech are left alone: NIM and the on-box routes do not
// train under their terms as far as checked (an assumption noted in the plan).

/** OpenRouter and Agnes publish no per-model training flag, so their free rows count as may train. */
const FREE_ROWS_MAY_TRAIN = new Set(["openrouter", "agnes"]);

export function routeMayTrain(providerId: string, modelId: string, free?: boolean): boolean {
    if (providerId === "gemini-free") return true;
    const row = catalogueSnapshot().rows.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
    if (row?.mayTrain === true) return true;
    return FREE_ROWS_MAY_TRAIN.has(providerId) && (free ?? row?.free) === true;
}

const KEY = Symbol.for("zuychin.assistant.maskPrefs");
const STALE_MS = 5 * 60_000;
type State = { at: number; prefs: MaskPrefs; refreshing: Promise<MaskPrefs> | null; autoRefresh: boolean };

function state(): State {
    const holder = globalThis as typeof globalThis & { [KEY]?: State };
    holder[KEY] ??= { at: 0, prefs: DEFAULT_MASK_PREFS, refreshing: null, autoRefresh: false };
    return holder[KEY];
}

/** The owner's masking choice, never awaited, so a model call does no reading of its own. Until the first read it is on with no names. */
export function maskPrefsSnapshot(): MaskPrefs {
    const current = state();
    if (current.autoRefresh && !current.refreshing && Date.now() - current.at > STALE_MS) void refreshMaskPrefs();
    return current.prefs;
}

/** A failed read keeps the last known choice. */
export async function refreshMaskPrefs(): Promise<MaskPrefs> {
    const current = state();
    current.refreshing ??= (async () => {
        try {
            const { resolveOwnerProfile } = await import("@/lib/owner-profile");
            rememberMaskPrefs(readMaskPrefs((await resolveOwnerProfile())?.preferences));
        } catch (error) {
            current.at = Date.now();
            console.warn("[Privacy] Could not read the masking choice:", error instanceof Error ? error.message : error);
        } finally {
            current.refreshing = null;
        }
        return current.prefs;
    })();
    return current.refreshing;
}

/** Production only (instrumentation), like the catalogue: tests never read the profile behind a model call. */
export function enableMaskPrefsRefresh(): void {
    state().autoRefresh = true;
}

/** Each chat turn passes the profile it already loaded, and a save passes the new choice; tests set it directly. */
export function rememberMaskPrefs(prefs: MaskPrefs): void {
    const current = state();
    current.prefs = prefs;
    current.at = Date.now();
}

export function maskerFor(providerId: string, modelId: string, free?: boolean): Masker | null {
    if (!routeMayTrain(providerId, modelId, free)) return null;
    const prefs = maskPrefsSnapshot();
    return prefs.enabled ? new Masker(prefs.names) : null;
}

export function logMasking(providerId: string, modelId: string, masker: Masker): void {
    if (masker.size) console.log(JSON.stringify({ event: "privacy_mask", provider: providerId, model: modelId, kinds: masker.kinds() }));
}
