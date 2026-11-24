import { catalogueSnapshot, rowKind, type CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { mediaKindsEnabled, type MediaKind } from "@/lib/ai/catalogue/sources";
import { removedModelKeys } from "@/lib/ai/models/profiles";
import { getProvider, getProviderApiKey, type ProviderConfig } from "@/lib/ai/providers";
import { mediaRouteSupported, type MediaRoute } from "@/lib/ai/media/requests";
import { readMediaChoices, type MediaChoice } from "@/lib/ai/media/choices";

export interface ResolvedMedia extends MediaRoute {
    provider: ProviderConfig;
    row: CatalogueRow;
}

const keyOf = (row: Pick<CatalogueRow, "providerId" | "modelId">) => `${row.providerId}::${row.modelId}`;

// Decision calls replace or gate paid Gemini calls in normal mode, so they stay on that tier (V8 Decision 15).
const PAID_FIRST: ReadonlySet<MediaKind> = new Set(["decision"]);

/** Tested, approved, listed and not retired. */
export function mediaRowUsable(row: CatalogueRow): boolean {
    return row.approvedAt !== null && row.probeStatus === "passed" && !row.missingSince && row.expiresSource !== "gone";
}

/**
 * The row a feature should use: the owner's choice when it is usable, else the first usable row. Free only takes free
 * rows alone. `routable` says whether the provider can be called now (key present, request shape known).
 */
export function pickMediaRow(kind: MediaKind, rows: readonly CatalogueRow[], input: {
    freeOnly: boolean;
    choice?: MediaChoice | null;
    removed?: ReadonlySet<string>;
    routable: (row: CatalogueRow) => boolean;
    filter?: (row: CatalogueRow) => boolean;
}): CatalogueRow | null {
    const eligible = rows.filter((row) => rowKind(row) === kind && mediaRowUsable(row) && (!input.freeOnly || row.free)
        && !input.removed?.has(keyOf(row)) && (input.filter?.(row) ?? true) && input.routable(row));
    const chosen = input.choice ? eligible.find((row) => row.providerId === input.choice!.providerId && row.modelId === input.choice!.modelId) : undefined;
    if (chosen) return chosen;
    const paidFirst = !input.freeOnly && PAID_FIRST.has(kind);
    return [...eligible].sort((a, b) => (paidFirst ? Number(a.free) - Number(b.free) : Number(b.free) - Number(a.free)) || a.label.localeCompare(b.label))[0] ?? null;
}

export function routableNow(row: CatalogueRow): boolean {
    const provider = getProvider(row.providerId);
    return !!provider && !provider.unavailableReason && !!getProviderApiKey(provider) && mediaRouteSupported(rowKind(row) as MediaKind, provider);
}

/** The model a V8 feature uses now, or null; every feature treats null as "use the fallback". */
export async function resolveModelOfKind(kind: MediaKind, options: { freeOnly: boolean; filter?: (row: CatalogueRow) => boolean }): Promise<ResolvedMedia | null> {
    if (!mediaKindsEnabled()) return null;
    const snapshot = catalogueSnapshot();
    const input = { ...options, removed: removedModelKeys(snapshot.profiles), routable: routableNow };
    // The choices live in the database; skip that read when no row could be used anyway.
    if (!pickMediaRow(kind, snapshot.typedRows, input)) return null;
    const choices = await readMediaChoices();
    const row = pickMediaRow(kind, snapshot.typedRows, { ...input, choice: choices[kind] });
    if (!row) return null;
    const provider = getProvider(row.providerId)!;
    return { provider, row, modelId: row.modelId, apiKey: getProviderApiKey(provider)! };
}

/** Both modes' picks per kind, for the in-use watch and /admin. */
export function mediaInUse(rows: readonly CatalogueRow[], choices: Partial<Record<MediaKind, MediaChoice>>, removed: ReadonlySet<string>, routable: (row: CatalogueRow) => boolean, kinds: readonly MediaKind[]): Partial<Record<MediaKind, { normal: CatalogueRow | null; freeOnly: CatalogueRow | null }>> {
    const out: Partial<Record<MediaKind, { normal: CatalogueRow | null; freeOnly: CatalogueRow | null }>> = {};
    for (const kind of kinds) {
        const pick = (freeOnly: boolean) => pickMediaRow(kind, rows, { freeOnly, choice: choices[kind], removed, routable });
        out[kind] = { normal: pick(false), freeOnly: pick(true) };
    }
    return out;
}
