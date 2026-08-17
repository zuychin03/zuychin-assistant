/**
 * Machine-level council host singleton (V3.5.5, owned by V4.1).
 *
 * The database lease already fences two hosts against the same council. It says
 * nothing about two hosts on the same machine, which is what actually happens:
 * a terminal launch and a shell launch, or a restart over a process that never
 * died. Both then bind different ports in the 8787-8791 range, both write a
 * token file, and the paired browser talks to whichever answered first.
 *
 * So the lock is keyed to the user, not to a checkout: ~/.zuychin holds it,
 * because .council-host lives beside a repo and two clones in different parents
 * would each get their own.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HostLockRecord {
    pid: number;
    hostId: string;
    port: number | null;
    repo: string;
    startedAt: string;
}

export type LockResult =
    | { ok: true; path: string; tookOverStale: boolean }
    | { ok: false; path: string; holder: HostLockRecord };

export function hostLockPath(): string {
    return join(homedir(), ".zuychin", "council-host.lock");
}

/**
 * EPERM means a process exists that we may not signal, which is still alive for
 * our purposes. Only ESRCH is proof of absence.
 */
function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function readLock(path: string): HostLockRecord | null {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HostLockRecord>;
        if (typeof parsed.pid !== "number" || typeof parsed.hostId !== "string") return null;
        return {
            pid: parsed.pid,
            hostId: parsed.hostId,
            port: typeof parsed.port === "number" ? parsed.port : null,
            repo: typeof parsed.repo === "string" ? parsed.repo : "",
            startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        };
    } catch {
        return null;
    }
}

/**
 * Exclusive create, then one stale takeover. Two hosts racing from cold both
 * miss the file; the loser gets EEXIST from the winner's write rather than
 * silently sharing the machine.
 */
export function acquireHostLock(record: Omit<HostLockRecord, "startedAt">): LockResult {
    return acquireHostLockAt(hostLockPath(), record);
}

/** Path-explicit so the suite can exercise the race without touching the real lock. */
export function acquireHostLockAt(path: string, record: Omit<HostLockRecord, "startedAt">): LockResult {
    mkdirSync(dirname(path), { recursive: true });
    const payload = JSON.stringify({ ...record, startedAt: new Date().toISOString() }, null, 2);

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(path, payload, { flag: "wx", mode: 0o600 });
            return { ok: true, path, tookOverStale: attempt > 0 };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const holder = readLock(path);
        // An unreadable or truncated lock is treated as stale: it can only come
        // from a host that died mid-write, and refusing forever on a corrupt
        // file would need a manual delete nobody would know to do.
        if (holder && holder.pid !== record.pid && pidAlive(holder.pid)) {
            return { ok: false, path, holder };
        }
        rmSync(path, { force: true });
    }
    return { ok: false, path, holder: readLock(path) ?? { pid: 0, hostId: "", port: null, repo: "", startedAt: "" } };
}

/** Only ever removes our own lock, so a takeover cannot be undone by the loser. */
export function releaseHostLock(hostId: string): void {
    releaseHostLockAt(hostLockPath(), hostId);
}

export function releaseHostLockAt(path: string, hostId: string): void {
    const holder = readLock(path);
    if (holder && holder.hostId !== hostId) return;
    rmSync(path, { force: true });
}
