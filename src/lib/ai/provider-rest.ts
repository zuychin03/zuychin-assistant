import { APP_TIMEZONE } from "@/lib/datetime";

// A spent free allowance is not a model failure (docs/V8_FREE_PROVIDERS_PLAN.md Decision 5). While a provider rests,
// the catalogue run and adapters skip it and its probes never count as failed. Kept in cron_state so a restart remembers.

export const PROVIDER_REST_KEY = "provider_rest";

export interface ProviderRest {
    until: string;
    since: string;
    reason: string;
}

export type RestState = Record<string, ProviderRest>;

export interface RestIo {
    load(): Promise<RestState | null>;
    save(state: RestState): Promise<void>;
    notify(text: string): Promise<void>;
}

// Workers AI "Account limited" (Cloudflare errors page, 06/11/2026): HTTP 429, code 3036, reset 00:00 UTC.
const CLOUDFLARE_DAILY = /(daily free allocation|"code"\s*:\s*3036\b)/i;

function nextUtcMidnight(nowMs: number): number {
    const day = new Date(nowMs);
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}

function nextUtcMonth(nowMs: number): number {
    const day = new Date(nowMs);
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1);
}

/** When the rest a quota reply starts ends, or null for any other reply. */
export function quotaRestUntil(providerId: string, status: number | null, detail: string | null | undefined, nowMs: number): number | null {
    if (providerId === "cloudflare" && status === 429 && detail && CLOUDFLARE_DAILY.test(detail)) return nextUtcMidnight(nowMs);
    // Not yet seen live: LlamaParse pauses new jobs when the month's credits run out.
    if (providerId === "llamaparse" && (status === 402 || (status === 429 && /credit/i.test(detail ?? "")))) return nextUtcMonth(nowMs);
    return null;
}

/** The first quota reply among a probe's steps, as the time its rest ends. */
export function quotaRestFromSteps(providerId: string, steps: Readonly<Record<string, { httpStatus: number | null; detail: string | null }>>, nowMs: number): number | null {
    for (const step of Object.values(steps)) {
        const until = quotaRestUntil(providerId, step.httpStatus, step.detail, nowMs);
        if (until !== null) return until;
    }
    return null;
}

const STATE_KEY = Symbol.for("zuychin.assistant.providerRest");

interface State {
    entries: RestState;
    loaded: boolean;
}

function state(): State {
    const holder = globalThis as typeof globalThis & { [STATE_KEY]?: State };
    holder[STATE_KEY] ??= { entries: {}, loaded: false };
    return holder[STATE_KEY];
}

function parseRestState(raw: unknown): RestState {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const out: RestState = {};
    for (const [providerId, entry] of Object.entries(value)) {
        const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        if (typeof item.until === "string" && Number.isFinite(Date.parse(item.until))) {
            out[providerId] = { until: item.until, since: typeof item.since === "string" ? item.since : item.until, reason: typeof item.reason === "string" ? item.reason.slice(0, 200) : "" };
        }
    }
    return out;
}

function current(entries: RestState, nowMs: number): RestState {
    return Object.fromEntries(Object.entries(entries).filter(([, entry]) => Date.parse(entry.until) > nowMs));
}

/** The end of a provider's rest as epoch ms, or null when it is not resting. */
export function restingUntil(providerId: string, nowMs = Date.now()): number | null {
    const entry = state().entries[providerId];
    const until = entry ? Date.parse(entry.until) : NaN;
    return Number.isFinite(until) && until > nowMs ? until : null;
}

/** Providers resting now, for the dashboard. */
export function providerRestSnapshot(nowMs = Date.now()): RestState {
    return current(state().entries, nowMs);
}

export const liveRestIo: RestIo = {
    async load() {
        const { getCronState } = await import("@/lib/cron-state");
        return parseRestState(await getCronState(PROVIDER_REST_KEY, AbortSignal.timeout(5000)));
    },
    async save(entries) {
        const { setCronState } = await import("@/lib/cron-state");
        await setCronState(PROVIDER_REST_KEY, entries, AbortSignal.timeout(10_000));
    },
    async notify(text) {
        const { notify } = await import("@/lib/messaging/router");
        await notify("model_catalogue", text);
    },
};

/** Reads the stored rests once per process, or again with `force`. A failed read keeps what is in memory. */
export async function loadProviderRest(io: RestIo = liveRestIo, force = false): Promise<void> {
    const held = state();
    if (held.loaded && !force) return;
    try {
        const stored = await io.load();
        held.entries = { ...current(stored ?? {}, Date.now()), ...current(held.entries, Date.now()) };
        held.loaded = true;
    } catch (error) {
        console.error("[ProviderRest] Could not read the stored rests:", error instanceof Error ? error.message : error);
    }
}

function localTime(ms: number): string {
    return new Date(ms).toLocaleString("en-AU", { timeZone: APP_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false, day: "2-digit", month: "2-digit", year: "numeric", timeZoneName: "short" });
}

export function restNotice(label: string, untilMs: number, kinds: readonly string[]): string {
    const utc = new Date(untilMs).toISOString().slice(11, 16);
    const fallback = kinds.length
        ? `${kinds.join(", ")} use their other routes until then.`
        : "Nothing approved depends on it, so nothing changes.";
    return `**${label} is resting** until ${localTime(untilMs)} (${utc} UTC): its free allowance is used up. ${fallback}`;
}

/**
 * Starts a rest and sends one notice for it. A provider already resting to the same time or later is left alone,
 * so several replies from one spent allowance send one notice. Re-reads the stored state first, since the web
 * server and the bot are separate processes.
 */
export async function enterProviderRest(
    input: { providerId: string; label: string; untilMs: number; reason: string; kinds?: readonly string[] },
    io: RestIo = liveRestIo,
    nowMs = Date.now(),
): Promise<boolean> {
    await loadProviderRest(io, true);
    const held = state();
    const resting = restingUntil(input.providerId, nowMs);
    if (resting !== null && resting >= input.untilMs) return false;
    held.entries = {
        ...current(held.entries, nowMs),
        [input.providerId]: { until: new Date(input.untilMs).toISOString(), since: new Date(nowMs).toISOString(), reason: input.reason.slice(0, 200) },
    };
    console.info(`[ProviderRest] ${input.providerId} resting until ${new Date(input.untilMs).toISOString()}: ${input.reason.slice(0, 120)}`);
    await io.save(held.entries).catch((error) => console.error("[ProviderRest] Could not store the rest:", error instanceof Error ? error.message : error));
    await io.notify(restNotice(input.label, input.untilMs, input.kinds ?? [])).catch((error) => console.error("[ProviderRest] Could not send the notice:", error instanceof Error ? error.message : error));
    return true;
}

export function setProviderRestForTests(entries: RestState = {}): void {
    state().entries = entries;
    state().loaded = true;
}
