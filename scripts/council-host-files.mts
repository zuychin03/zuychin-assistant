/**
 * Writes for the host's small state files that a reader can only ever see whole.
 * A torn identity file makes the next host mint a fresh pairing code, and a lock
 * caught between its create and its write reads as stale to a racing host.
 */
import { randomBytes } from "node:crypto";
import { linkSync, renameSync, rmSync, writeFileSync } from "node:fs";

function temporaryBeside(path: string): string {
    return `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

const IN_USE = new Set(["EPERM", "EACCES", "EBUSY"]);

// Windows cannot replace a file while any process holds it open (Node renames
// with MoveFileEx), so short retries absorb a passing indexer or scanner.
function renameReplacing(from: string, to: string): boolean {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            renameSync(from, to);
            return true;
        } catch (error) {
            if (!IN_USE.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
        }
    }
    return false;
}

/**
 * Replaces `path` so a reader sees the old content or the new, never a mix. If
 * something keeps the file open past the retries it is written in place as
 * before, because a host that cannot start is worse than the rare torn file.
 */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
    const temporary = temporaryBeside(path);
    writeFileSync(temporary, data, { mode, flag: "wx" });
    try {
        if (!renameReplacing(temporary, path)) writeFileSync(path, data, { mode });
    } finally {
        rmSync(temporary, { force: true });
    }
}

/**
 * Creates `path` only if it does not exist, already holding its full content: a
 * hard link from a written temporary fails with EEXIST like an exclusive create
 * but never exposes an empty file. Filesystems without hard links fall back to
 * the plain exclusive create.
 */
export function createFileExclusive(path: string, data: string, mode = 0o600): void {
    const temporary = temporaryBeside(path);
    writeFileSync(temporary, data, { mode, flag: "wx" });
    try {
        linkSync(temporary, path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
        writeFileSync(path, data, { mode, flag: "wx" });
    } finally {
        rmSync(temporary, { force: true });
    }
}
