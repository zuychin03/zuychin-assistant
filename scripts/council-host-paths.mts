/**
 * Path and command resolution shared by council-host.mts and
 * council-acp-probe.mts. Shared so the containment check is testable on its own,
 * and so the probe spawns a candidate exactly as the host will.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export function onPath(command: string): boolean {
    const probe = process.platform === "win32" ? "where" : "which";
    return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

// npm installs three shims per bin on Windows and `where` lists the
// extensionless one first, which CreateProcess cannot execute. Pick the .cmd,
// never the .ps1.
export function resolveCommand(command: string): string {
    if (process.platform !== "win32") return command;
    if (/\.(exe|cmd|bat|com)$/i.test(command)) return command;
    const found = spawnSync("where", [command], { encoding: "utf8" });
    if (found.status !== 0) return command;
    const matches = found.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return matches.find((m) => /\.(cmd|bat|exe)$/i.test(m)) ?? matches[0] ?? command;
}

// cmd.exe /s quoting: wrap in ", double embedded ".
function quoteForCmd(arg: string): string {
    if (!/[ \t"]/u.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Spawn the way the host always must: resolveCommand first, then on Windows
 * drive .cmd/.bat through cmd.exe. Node 18.20+/20.12+ returns EINVAL for a
 * direct spawn of batch files (CVE-2024-27980). shell:true would concat args
 * unescaped; /d /s /c + windowsVerbatimArguments keeps our quoting intact.
 */
export function spawnResolved(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
): ChildProcess {
    const resolved = resolveCommand(command);
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
        const cmdline = [quoteForCmd(resolved), ...args.map(quoteForCmd)].join(" ");
        return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", cmdline], {
            ...options,
            windowsVerbatimArguments: true,
        });
    }
    return spawn(resolved, args as string[], options);
}

/**
 * Kill a spawned process and everything under it. A .cmd shim runs through
 * cmd.exe, so child.kill() reaps the wrapper and orphans the real agent.
 */
export function killTree(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        return;
    }
    child.kill();
}

// The target of a write need not exist yet, so resolve the deepest existing
// ancestor and re-append the tail. Without this a write to a not-yet-created
// file inside the tree would fail the check on ENOENT.
export async function realpathParent(candidate: string): Promise<string> {
    let current = resolve(candidate);
    const tail: string[] = [];
    for (;;) {
        try {
            const real = await realpath(current);
            return tail.length ? join(real, ...[...tail].reverse()) : real;
        } catch {
            const parent = dirname(current);
            if (parent === current) return resolve(candidate);
            tail.push(basename(current));
            current = parent;
        }
    }
}

/**
 * Two traps this deliberately avoids. String prefix matching passes
 * "<tree>-evil" as inside "<tree>"; path.relative does not. And a symlink
 * planted inside the tree can point anywhere, so both sides are realpath'd
 * before they are compared.
 */
export async function insideWorktree(candidate: string, treeDir: string): Promise<boolean> {
    try {
        const [real, root] = await Promise.all([realpathParent(candidate), realpath(treeDir)]);
        const rel = relative(root, real);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    } catch {
        return false;
    }
}
