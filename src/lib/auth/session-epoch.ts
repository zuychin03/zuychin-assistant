/** Seconds since the epoch before which every session cookie is refused; null cancels nothing. */
export type EpochSource = () => Promise<number | null>;

export class SessionEpochMissingError extends Error {
    constructor() { super("Run scripts/migrations/v7-security-hardening.sql first."); }
}

const CACHE_MS = 30_000;
const RETRY_MS = 5_000;
const MISSING = new Set(["PGRST205", "42P01"]);

interface EpochState {
    value: number | null;
    known: boolean;
    loadedAt: number;
    pending?: Promise<number | null>;
    source: EpochSource;
    warnedAt: number;
    warnedMissing: boolean;
}

// The proxy and the route handlers are separate bundles in one process; a global keeps one cache for both.
const KEY = Symbol.for("zuychin.auth.sessionEpoch");
function state(): EpochState {
    const holder = globalThis as unknown as Record<symbol, EpochState | undefined>;
    return holder[KEY] ??= { value: null, known: false, loadedAt: 0, source: readEpoch, warnedAt: 0, warnedMissing: false };
}

async function table() {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return null;
    const { supabaseAdmin } = await import("@/lib/supabase");
    return supabaseAdmin.from("auth_session_epoch");
}

function missingTable(error: { code?: string } | null): boolean {
    return Boolean(error && MISSING.has(error.code ?? ""));
}

async function readEpoch(): Promise<number | null> {
    const from = await table();
    if (!from) return null;
    const { data, error } = await from.select("valid_after").eq("id", true).abortSignal(AbortSignal.timeout(3000)).maybeSingle();
    if (missingTable(error)) {
        const current = state();
        if (!current.warnedMissing) {
            current.warnedMissing = true;
            console.warn("[Auth] auth_session_epoch is missing; apply scripts/migrations/v7-security-hardening.sql. Sign out everywhere is off.");
        }
        return null;
    }
    if (error) throw new Error(error.message);
    const at = data ? Date.parse(String(data.valid_after)) : NaN;
    return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}

/**
 * Cached for 30 seconds. A failed read keeps the last known value, or accepts every cookie on a cold
 * start: with the database down there is no data to reach, and failing closed would lock the owner out.
 */
export function sessionValidAfter(): Promise<number | null> {
    const current = state();
    if (current.known && Date.now() - current.loadedAt < CACHE_MS) return Promise.resolve(current.value);
    current.pending ??= current.source()
        .then((value) => {
            current.value = value;
            current.known = true;
            current.loadedAt = Date.now();
            return value;
        })
        .catch((error) => {
            if (Date.now() - current.warnedAt > 60_000) {
                current.warnedAt = Date.now();
                console.warn("[Auth] Could not read the session epoch; using the last known value:", error instanceof Error ? error.message : error);
            }
            current.loadedAt = Date.now() - CACHE_MS + RETRY_MS;
            return current.known ? current.value : null;
        })
        .finally(() => { current.pending = undefined; });
    return current.pending;
}

/** Cancels every session cookie issued before now. Throws SessionEpochMissingError until the migration is applied. */
export async function signOutEverywhere(nowSeconds = Math.floor(Date.now() / 1000)): Promise<number> {
    const from = await table();
    if (!from) throw new Error("Supabase is not configured.");
    const { error } = await from.upsert({ id: true, valid_after: new Date(nowSeconds * 1000).toISOString(), updated_at: new Date().toISOString() })
        .abortSignal(AbortSignal.timeout(5000));
    if (missingTable(error)) throw new SessionEpochMissingError();
    if (error) throw new Error("The sign-out time could not be saved. Try again.");
    const current = state();
    current.value = nowSeconds;
    current.known = true;
    current.loadedAt = Date.now();
    return nowSeconds;
}

/** Read fresh for the admin panel. configured is false until the migration is applied. */
export async function sessionEpochStatus(): Promise<{ configured: boolean; validAfter: string | null }> {
    const from = await table();
    if (!from) return { configured: false, validAfter: null };
    const { data, error } = await from.select("valid_after").eq("id", true).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (missingTable(error)) return { configured: false, validAfter: null };
    if (error) throw new Error("The sign-out time could not be read.");
    return { configured: true, validAfter: data ? String(data.valid_after) : null };
}

/** Tests replace the database read; passing nothing restores it. Clears the cache either way. */
export function setSessionEpochSourceForTests(source?: EpochSource): void {
    const current = state();
    current.source = source ?? readEpoch;
    current.known = false;
    current.loadedAt = 0;
    current.pending = undefined;
}
