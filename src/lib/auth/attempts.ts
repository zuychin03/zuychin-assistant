import { validPassword } from "./server";

// One long-lived process serves the site, so these counters see every request.
// A restart clears them, which only ends a lockout early.

const WINDOW_MS = 15 * 60_000;
const PER_CLIENT = 10;
const GLOBAL = 200;

type Bucket = { failures: number; resetAt: number };
const clients = new Map<string, Bucket>();
let everyone: Bucket = { failures: 0, resetAt: 0 };

// Cloudflare sets cf-connecting-ip and appends the real address to any
// x-forwarded-for the client sent, so only the last hop can be trusted.
export function clientAddress(headers: Headers): string {
    const connecting = headers.get("cf-connecting-ip")?.trim();
    if (connecting) return connecting;
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",").at(-1)!.trim();
    return headers.get("x-real-ip") ?? "unknown";
}

function live(bucket: Bucket | undefined, now: number): Bucket {
    return bucket && bucket.resetAt > now ? bucket : { failures: 0, resetAt: now + WINDOW_MS };
}

export function passwordAttemptsBlocked(client: string, now = Date.now()): boolean {
    return live(clients.get(client), now).failures >= PER_CLIENT || live(everyone, now).failures >= GLOBAL;
}

export function recordPasswordFailure(client: string, now = Date.now()): void {
    const bucket = live(clients.get(client), now);
    bucket.failures++;
    clients.set(client, bucket);
    everyone = live(everyone, now);
    everyone.failures++;
    if (clients.size > 10_000) {
        for (const [key, value] of clients) if (value.resetAt <= now) clients.delete(key);
    }
}

export function clearPasswordFailures(client: string): void {
    clients.delete(client);
}

export function checkPassword(client: string, password: unknown, now = Date.now()): "ok" | "wrong" | "blocked" {
    if (passwordAttemptsBlocked(client, now)) return "blocked";
    if (!validPassword(password)) {
        recordPasswordFailure(client, now);
        return "wrong";
    }
    clearPasswordFailures(client);
    return "ok";
}

export const TOO_MANY_ATTEMPTS = "Too many password attempts. Wait 15 minutes, or sign in with a passkey.";
