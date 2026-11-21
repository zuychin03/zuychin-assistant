import { resolveModelKey, type ResolvedChat } from "@/lib/ai/providers";
import { MODERATOR_NAME } from "@/lib/council/protocol";
import { DEFAULT_STANCES } from "./angles";

export { DEFAULT_STANCES } from "./angles";

export interface OnlineSeatInput {
    modelKey: string;
    name?: string;
    expertise?: string;
    /** How the model was chosen, recorded as the execution's model source. */
    source?: string;
}

export interface OnlineSeat {
    name: string;
    expertise: string;
    modelKey: string;
    source: string;
    resolved: ResolvedChat;
    paid: boolean;
}

export interface SeatPolicy {
    freeOnly: boolean;
    allowPaid: boolean;
}

export const MIN_SEATS = 2;
export const MAX_SEATS = 5;
const MAX_NAME_CHARS = 40;
export const MAX_EXPERTISE_CHARS = 300;

/** Same rule as the roster: free routes only when the model and provider are both unmetered and marked free. */
export function isPaidModel(resolved: ResolvedChat): boolean {
    return resolved.model.free !== true || resolved.model.metered === true || resolved.provider.metered === true;
}

/** Why this model may not hold a seat now, or null. Removed and unavailable models never resolve. */
export function seatRefusal(modelKey: string, resolved: ResolvedChat | null, policy: SeatPolicy): string | null {
    if (!resolved) return `${modelKey} is not in the selectable model list (removed, unavailable, or its provider has no key).`;
    if (!isPaidModel(resolved)) return null;
    if (policy.freeOnly) return `${resolved.model.label} is a paid model and Free only is on.`;
    if (!policy.allowPaid) return `${resolved.model.label} is a paid model. Tick Allow paid to seat it.`;
    return null;
}

function cleanName(raw: string): string {
    return raw.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").slice(0, MAX_NAME_CHARS);
}

function uniqueName(base: string, taken: Set<string>): string {
    let name = base || "seat";
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    taken.add(name.toLowerCase());
    return name;
}

export function resolveSeats(
    inputs: readonly OnlineSeatInput[],
    policy: SeatPolicy,
    resolve: (key: string) => ResolvedChat | null = resolveModelKey,
): { ok: true; seats: OnlineSeat[] } | { ok: false; error: string } {
    if (inputs.length < MIN_SEATS || inputs.length > MAX_SEATS) {
        return { ok: false, error: `A council takes ${MIN_SEATS} to ${MAX_SEATS} seats; got ${inputs.length}.` };
    }
    const named = new Set<string>();
    for (const input of inputs) {
        const name = input.name ? cleanName(input.name) : "";
        if (!name) continue;
        if (name.toLowerCase() === MODERATOR_NAME) return { ok: false, error: `"${MODERATOR_NAME}" is reserved for the moderator.` };
        if (named.has(name.toLowerCase())) return { ok: false, error: `Seat names must be unique; "${name}" is used twice.` };
        named.add(name.toLowerCase());
    }

    const taken = new Set(named);
    const seats: OnlineSeat[] = [];
    for (const [index, input] of inputs.entries()) {
        const modelKey = typeof input.modelKey === "string" ? input.modelKey.trim() : "";
        const resolved = modelKey ? resolve(modelKey) : null;
        const refusal = seatRefusal(modelKey || "(no model)", resolved, policy);
        if (refusal || !resolved) return { ok: false, error: refusal ?? "No model." };
        const given = input.name ? cleanName(input.name) : "";
        const fallback = cleanName(resolved.model.name) || `seat-${index + 1}`;
        const name = given || uniqueName(fallback === MODERATOR_NAME ? `${fallback}-seat` : fallback, taken);
        const expertise = (input.expertise ?? "").trim().slice(0, MAX_EXPERTISE_CHARS) || DEFAULT_STANCES[index % DEFAULT_STANCES.length];
        seats.push({
            name, expertise, modelKey: `${resolved.provider.id}::${resolved.model.id}`,
            source: input.source?.trim() || "picker", resolved, paid: isPaidModel(resolved),
        });
    }
    return { ok: true, seats };
}

/** Who trained the model: the id's vendor prefix, or Google for Gemini routes. */
export function modelVendor(entry: { modelId: string; providerKind: string; providerId: string }): string {
    if (entry.modelId.includes("/")) return entry.modelId.split("/")[0].toLowerCase();
    return entry.providerKind === "gemini" ? "google" : entry.providerId;
}

/** The same model sold by different providers, e.g. OpenRouter's ":free" copy of a NIM model. */
export function modelFamily(modelId: string): string {
    return (modelId.split("/").pop() ?? modelId).replace(/:free$/i, "").toLowerCase();
}

/**
 * Picks for a purpose from an already ranked list: models tagged for it from
 * different vendors first, then any other vendor, then different models. One
 * model behind three providers is still one opinion.
 */
export function pickDiverse<T extends { key: string; modelId: string; providerKind: string; providerId: string; tags?: readonly string[] }>(
    candidates: readonly T[], count: number, purpose?: string,
): string[] {
    const picked: T[] = [];
    const newVendor = (entry: T) => !picked.some((p) => modelVendor(p) === modelVendor(entry));
    const passes: ((entry: T) => boolean)[] = [
        (entry) => purpose !== undefined && (entry.tags ?? []).includes(purpose) && newVendor(entry),
        newVendor,
        (entry) => !picked.some((p) => modelFamily(p.modelId) === modelFamily(entry.modelId)),
        () => true,
    ];
    for (const fits of passes) {
        for (const entry of candidates) {
            if (picked.length >= count) break;
            if (!picked.includes(entry) && fits(entry)) picked.push(entry);
        }
    }
    return picked.map((entry) => entry.key);
}
