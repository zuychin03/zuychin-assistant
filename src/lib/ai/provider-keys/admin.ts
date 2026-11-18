import { PROVIDERS, isProviderAvailable, providerKeySource, type ProviderConfig } from "@/lib/ai/providers";
import { authEnabled } from "@/lib/auth/config";
import { checkPassword, clientAddress, TOO_MANY_ATTEMPTS } from "@/lib/auth/attempts";
import { KEY_CHECKS, type KeyCheckResult } from "@/lib/ai/provider-keys/check";
import { deriveKey, encryptApiKey, lastFour, normaliseApiKey } from "@/lib/ai/provider-keys/crypto";
import { MASTER_CREDENTIAL, MASTER_ENV, type MasterKeys } from "@/lib/ai/provider-keys/master";
import { applyProviderKeyChange, providerKeySnapshot, type ProviderKeySnapshot } from "@/lib/ai/provider-keys/snapshot";
import type { KeyStore } from "@/lib/ai/provider-keys/store";

export interface ProviderKeyView {
    id: string;
    label: string;
    envVar: string;
    source: "dashboard" | "environment" | null;
    lastFour: string | null;
    savedAt: string | null;
    available: boolean;
    unavailableReason: string | null;
    checkable: boolean;
}

export interface ProviderKeysView {
    master: ProviderKeySnapshot["master"];
    masterSource: ProviderKeySnapshot["masterSource"];
    storage: ProviderKeySnapshot["storage"];
    otherRows: number;
    unreadable: readonly string[];
    rotated: readonly string[];
    rotationFailed: readonly string[];
    previousLoaded: boolean;
    passwordRequired: boolean;
    /** Why Save and Clear are off, or null when they work. */
    changesBlocked: string | null;
    providers: ProviderKeyView[];
}

export type CatalogueCheckStart = "started" | "busy" | "unavailable" | "skipped";

export interface KeyAdminDeps {
    store: KeyStore;
    masters: () => MasterKeys;
    check: (provider: ProviderConfig, apiKey: string) => Promise<KeyCheckResult>;
    notify: (text: string) => Promise<void>;
    startCatalogueCheck: () => Promise<CatalogueCheckStart>;
    now: () => Date;
}

export interface AdminResult {
    status: number;
    body: Record<string, unknown>;
}

export function changesBlockedReason(snapshot: ProviderKeySnapshot = providerKeySnapshot(), env: Readonly<Record<string, string | undefined>> = process.env): string | null {
    if (authEnabled() && !env.ACCESS_PASSWORD) return "Key changes need ACCESS_PASSWORD on the server, so they can be confirmed with the password.";
    if (snapshot.master === "missing") return `No master key is set. Add the ${MASTER_CREDENTIAL} credential on the server (or ${MASTER_ENV} in development) and restart.`;
    if (snapshot.master === "invalid") return `The master key is not 32 bytes of base64. Replace it with the output of "openssl rand -base64 32" and restart.`;
    if (snapshot.storage === "migration_required") return "Apply scripts/migrations/v7-provider-keys.sql first.";
    if (snapshot.storage === "unavailable") return "The key store could not be reached. Try again shortly.";
    return null;
}

export function providerKeysView(snapshot: ProviderKeySnapshot = providerKeySnapshot(), env: Readonly<Record<string, string | undefined>> = process.env): ProviderKeysView {
    return {
        master: snapshot.master,
        masterSource: snapshot.masterSource,
        storage: snapshot.storage,
        otherRows: snapshot.otherRows,
        unreadable: snapshot.unreadable,
        rotated: snapshot.rotated,
        rotationFailed: snapshot.rotationFailed,
        previousLoaded: snapshot.previousLoaded,
        passwordRequired: authEnabled(),
        changesBlocked: changesBlockedReason(snapshot, env),
        providers: PROVIDERS.map((provider) => {
            const source = providerKeySource(provider);
            const saved = snapshot.keys.get(provider.id);
            const envKey = env[provider.apiKeyEnv];
            return {
                id: provider.id,
                label: provider.label,
                envVar: provider.apiKeyEnv,
                source,
                lastFour: source === "dashboard" && saved ? saved.lastFour : source === "environment" && envKey ? lastFour(envKey.trim()) : null,
                savedAt: saved?.updatedAt || null,
                available: isProviderAvailable(provider),
                unavailableReason: provider.unavailableReason ?? null,
                checkable: provider.id in KEY_CHECKS,
            };
        }),
    };
}

/** Re-entering the access password guards every key change. With auth off (local development) there is nothing to check. */
export function confirmPassword(headers: Headers, password: unknown): AdminResult | null {
    if (!authEnabled()) return null;
    const checked = checkPassword(clientAddress(headers), password);
    if (checked === "blocked") return { status: 429, body: { error: TOO_MANY_ATTEMPTS } };
    if (checked === "wrong") return { status: 401, body: { error: "Enter your access password to change a key." } };
    return null;
}

function findProvider(providerId: unknown): ProviderConfig | null {
    return typeof providerId === "string" ? PROVIDERS.find((provider) => provider.id === providerId) ?? null : null;
}

function currentKey(deps: KeyAdminDeps) {
    const masters = deps.masters();
    return masters.current.ok ? deriveKey(masters.current.key) : null;
}

function storageError(reason: string): AdminResult {
    return reason === "migration_required"
        ? { status: 503, body: { error: "Apply scripts/migrations/v7-provider-keys.sql first." } }
        : { status: 503, body: { error: "The key store could not be reached. Try again shortly." } };
}

export async function saveProviderKey(input: { providerId: unknown; apiKey: unknown }, deps: KeyAdminDeps): Promise<AdminResult> {
    const provider = findProvider(input.providerId);
    if (!provider) return { status: 404, body: { error: "Unknown provider." } };
    const apiKey = normaliseApiKey(input.apiKey);
    if (!apiKey) return { status: 400, body: { error: "That does not look like an API key. Paste the whole key, with no spaces inside." } };
    const blocked = changesBlockedReason();
    if (blocked) return { status: 409, body: { error: blocked } };
    const key = currentKey(deps);
    if (!key) return { status: 409, body: { error: changesBlockedReason() ?? "No master key is set." } };

    const check = await deps.check(provider, apiKey);
    if (check.outcome === "rejected") return { status: 400, body: { error: `${provider.label} rejected this key (HTTP ${check.status}). It was not saved.`, check } };

    const replaced = providerKeySnapshot().keys.has(provider.id);
    const saved = await deps.store.save(provider.id, key.ref, encryptApiKey(key, provider.id, apiKey));
    if (saved !== "ok") return storageError(saved);
    applyProviderKeyChange(provider.id, { apiKey, updatedAt: deps.now().toISOString() });
    console.info(`[ProviderKeys] Key ${replaced ? "replaced" : "saved"} for ${provider.id} from the dashboard.`);
    await deps.notify(`Provider key ${replaced ? "replaced" : "saved"} for ${provider.label} from the dashboard.`).catch(() => {});
    const catalogueCheck: CatalogueCheckStart = provider.discovery ? await deps.startCatalogueCheck().catch((): CatalogueCheckStart => "unavailable") : "skipped";
    return {
        status: 200,
        body: {
            saved: true, replaced, check, catalogueCheck,
            ...(check.outcome === "unknown" ? { warning: `Saved, but ${check.message.charAt(0).toLowerCase()}${check.message.slice(1)} Press Test to try again.` } : {}),
            view: providerKeysView(),
        },
    };
}

export async function clearProviderKey(input: { providerId: unknown }, deps: KeyAdminDeps): Promise<AdminResult> {
    const provider = findProvider(input.providerId);
    if (!provider) return { status: 404, body: { error: "Unknown provider." } };
    const blocked = changesBlockedReason();
    if (blocked) return { status: 409, body: { error: blocked } };
    const key = currentKey(deps);
    if (!key) return { status: 409, body: { error: changesBlockedReason() ?? "No master key is set." } };
    if (!providerKeySnapshot().keys.has(provider.id)) return { status: 404, body: { error: `No key is saved on the dashboard for ${provider.label}.` } };

    const removed = await deps.store.remove(provider.id, key.ref);
    if (removed !== "ok") return storageError(removed);
    applyProviderKeyChange(provider.id, null);
    const fallback = providerKeySource(provider) === "environment" ? `the ${provider.apiKeyEnv} env var` : "no key";
    console.info(`[ProviderKeys] Key cleared for ${provider.id} from the dashboard.`);
    await deps.notify(`Provider key cleared for ${provider.label} from the dashboard. It now uses ${fallback}.`).catch(() => {});
    return { status: 200, body: { cleared: true, view: providerKeysView() } };
}
