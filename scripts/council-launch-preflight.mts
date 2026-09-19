import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { COUNCIL_CODE_PATTERN, councilBranch, councilWorktreeDir } from "../src/lib/council/protocol.ts";
import { realpathParent } from "./council-host-paths.mts";

type GitRunner = (repo: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

export function configuredSelection(params: {
    name: string; selection: unknown; defaultModel: string | null; defaultReasoningEffort: string | null;
    allowedModels: string[]; allowedReasoningEfforts: string[];
}): { requestedModel: string | null; requestedReasoningEffort: string | null } {
    const selection = params.selection ?? {};
    if (typeof selection !== "object" || Array.isArray(selection)) throw new Error(`${params.name}: invalid model selection`);
    const values = selection as Record<string, unknown>;
    const requestedModel = values.modelId ?? params.defaultModel;
    const requestedReasoningEffort = values.reasoningEffort ?? params.defaultReasoningEffort;
    if (requestedModel !== null && (typeof requestedModel !== "string" || !params.allowedModels.includes(requestedModel))) {
        throw new Error(`${params.name}: model "${String(requestedModel)}" is not in allowedModels`);
    }
    if (requestedReasoningEffort !== null && (typeof requestedReasoningEffort !== "string" || !params.allowedReasoningEfforts.includes(requestedReasoningEffort))) {
        throw new Error(`${params.name}: reasoning effort "${String(requestedReasoningEffort)}" is not allowed`);
    }
    return { requestedModel, requestedReasoningEffort };
}

async function requireAbsent(path: string): Promise<void> {
    try {
        await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    throw new Error(`${path} already exists; remove it or choose a new council code`);
}

async function pathKey(path: string): Promise<string> {
    const canonical = await realpathParent(path);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export async function preflightCouncilPaths(repo: string, code: string, names: string[], git: GitRunner): Promise<void> {
    if (!COUNCIL_CODE_PATTERN.test(code)) throw new Error("invalid requested council code");
    const branches = names.map((name) => councilBranch(code, name));
    if (new Set(branches).size !== names.length) throw new Error("agent names produce colliding worktree branches");
    const paths = names.map((name) => resolve(repo, councilWorktreeDir(repo, code, name)));
    const runDir = join(repo, "..", `.council-run-${code.toLowerCase()}`);
    await Promise.all([...paths, runDir].map(requireAbsent));
    await access(dirname(runDir), constants.W_OK);

    const [heads, worktrees, ignoreCase] = await Promise.all([
        git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]),
        git(repo, ["worktree", "list", "--porcelain", "-z"]),
        git(repo, ["config", "--bool", "core.ignorecase"]),
    ]);
    if (!heads.ok || !worktrees.ok) throw new Error("could not inspect existing worktree paths and branches");
    const foldCase = process.platform === "win32" || (ignoreCase.ok && ignoreCase.out === "true");
    const refKey = (ref: string) => foldCase ? ref.toLowerCase() : ref;
    const existingHeads = heads.out.split(/\r?\n/).filter(Boolean).map((head) => head.replace(/^refs\/heads\//, ""));
    for (const branch of branches) {
        const planned = refKey(branch);
        const collision = existingHeads.find((head) => {
            const existing = refKey(head);
            return existing === planned || existing.startsWith(`${planned}/`) || planned.startsWith(`${existing}/`);
        });
        if (collision) throw new Error(`branch ${branch} collides with existing branch ${collision}`);
    }
    const registered = worktrees.out.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
    const registeredPaths = new Set(await Promise.all(registered.map(pathKey)));
    for (const path of paths) {
        if (registeredPaths.has(await pathKey(path))) throw new Error(`${path} is already registered as a git worktree`);
    }
}

export async function requireLaunchPreflightProtocol(listTools: (cursor?: string) => Promise<{
    tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[]; nextCursor?: string;
}>): Promise<void> {
    let cursor: string | undefined;
    const visited = new Set<string>();
    do {
        const result = await listTools(cursor);
        const convene = result.tools?.find((tool) => tool.name === "council_convene");
        if (convene) {
            if (convene.inputSchema?.properties?.requestedCode) return;
            break;
        }
        cursor = result.nextCursor;
        if (cursor && visited.has(cursor)) break;
        if (cursor) visited.add(cursor);
    } while (cursor);
    throw new Error("Council server does not support launch preflight; update it before convening");
}
