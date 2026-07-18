const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

export interface VaultConfig {
    owner: string;
    repo: string;
    branch: string;
    token: string;
}

export interface VaultFile {
    path: string;
    text: string;
    sha: string;
}

export interface VaultEntry {
    path: string;
    name: string;
    type: "file" | "dir";
    sha: string;
}

export interface CommitFileChange {
    path: string;
    /** Ignored when delete is true. */
    content?: string;
    contentBase64?: string;
    delete?: boolean;
}

export function getVaultConfig(): VaultConfig | null {
    const token = process.env.GITHUB_VAULT_TOKEN;
    const repo = process.env.GITHUB_VAULT_REPO;
    if (!token || !repo) return null;

    const [owner, name] = repo.split("/");
    if (!owner || !name) return null;

    return {
        owner,
        repo: name,
        branch: process.env.GITHUB_VAULT_BRANCH || "main",
        token,
    };
}

export function requireVaultConfig(): VaultConfig {
    const cfg = getVaultConfig();
    if (!cfg) {
        throw new Error("Vault is not configured. Set GITHUB_VAULT_TOKEN and GITHUB_VAULT_REPO.");
    }
    return cfg;
}

async function githubFetch(
    cfg: VaultConfig,
    path: string,
    init?: RequestInit,
): Promise<Response> {
    return fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${cfg.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "Content-Type": "application/json",
            ...(init?.headers ?? {}),
        },
    });
}

async function githubJson<T>(cfg: VaultConfig, path: string, init?: RequestInit): Promise<T> {
    const res = await githubFetch(cfg, path, init);
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`GitHub ${res.status} on ${path}: ${detail.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
}

function repoPath(cfg: VaultConfig, suffix: string): string {
    return `/repos/${cfg.owner}/${cfg.repo}${suffix}`;
}

function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

function toBase64(text: string): string {
    return Buffer.from(text, "utf-8").toString("base64");
}

function fromBase64(content: string): string {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf-8");
}

export async function getFile(cfg: VaultConfig, path: string): Promise<VaultFile | null> {
    const res = await githubFetch(
        cfg,
        repoPath(cfg, `/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch)}`),
    );
    if (res.status === 404) return null;
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`GitHub ${res.status} reading ${path}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { content?: string; sha: string; type: string };
    return { path, text: fromBase64(data.content ?? ""), sha: data.sha };
}
export async function getBinaryFile(
    cfg: VaultConfig,
    path: string,
): Promise<{ path: string; content: Buffer; sha: string } | null> {
    const res = await githubFetch(
        cfg,
        repoPath(cfg, `/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch)}`),
    );
    if (res.status === 404) return null;
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`GitHub ${res.status} reading ${path}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { content?: string; sha: string };
    let encoded = data.content;
    if (!encoded) {
        const blob = await githubJson<{ content: string; encoding: string }>(
            cfg,
            repoPath(cfg, `/git/blobs/${data.sha}`),
        );
        if (blob.encoding !== "base64") throw new Error(`Unexpected blob encoding for ${path}.`);
        encoded = blob.content;
    }
    return { path, content: Buffer.from(encoded.replace(/\n/g, ""), "base64"), sha: data.sha };
}


export async function putFile(
    cfg: VaultConfig,
    path: string,
    content: string,
    message: string,
    sha?: string,
): Promise<{ sha: string; commit: string }> {
    const body: Record<string, unknown> = {
        message,
        content: toBase64(content),
        branch: cfg.branch,
    };
    if (sha) body.sha = sha;

    const data = await githubJson<{ content: { sha: string }; commit: { sha: string } }>(
        cfg,
        repoPath(cfg, `/contents/${encodePath(path)}`),
        { method: "PUT", body: JSON.stringify(body) },
    );
    return { sha: data.content.sha, commit: data.commit.sha };
}

export async function listDir(cfg: VaultConfig, dir: string): Promise<VaultEntry[]> {
    const res = await githubFetch(
        cfg,
        repoPath(cfg, `/contents/${encodePath(dir)}?ref=${encodeURIComponent(cfg.branch)}`),
    );
    if (res.status === 404) return [];
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`GitHub ${res.status} listing ${dir}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { path: string; name: string; type: string; sha: string }[];
    if (!Array.isArray(data)) return [];
    return data.map((e) => ({
        path: e.path,
        name: e.name,
        type: e.type === "dir" ? "dir" : "file",
        sha: e.sha,
    }));
}
export async function listAllFiles(cfg: VaultConfig): Promise<VaultEntry[]> {
    const head = await getBranchHead(cfg);
    const result = await githubJson<{
        truncated: boolean;
        tree: { path: string; type: string; sha: string }[];
    }>(cfg, repoPath(cfg, `/git/trees/${head}?recursive=1`));
    if (result.truncated) {
        throw new Error("The vault tree is too large for a complete safe scan.");
    }
    return result.tree.filter((entry) => entry.type === "blob").map((entry) => ({
        path: entry.path,
        name: entry.path.split("/").pop() ?? entry.path,
        type: "file",
        sha: entry.sha,
    }));
}

export async function getBranchHead(cfg: VaultConfig): Promise<string> {
    const ref = await githubJson<{ object: { sha: string } }>(
        cfg,
        repoPath(cfg, `/git/ref/heads/${encodeURIComponent(cfg.branch)}`),
    );
    return ref.object.sha;
}


export async function commitFiles(
    cfg: VaultConfig,
    changes: CommitFileChange[],
    message: string,
): Promise<{ commit: string }> {
    if (changes.length === 0) throw new Error("commitFiles called with no changes.");

    const ref = await githubJson<{ object: { sha: string } }>(
        cfg,
        repoPath(cfg, `/git/ref/heads/${encodeURIComponent(cfg.branch)}`),
    );
    const headSha = ref.object.sha;

    const headCommit = await githubJson<{ tree: { sha: string } }>(
        cfg,
        repoPath(cfg, `/git/commits/${headSha}`),
    );
    const baseTree = headCommit.tree.sha;

    const entries = await Promise.all(changes.map(async (change) => {
        if (change.delete) {
            return { path: change.path, mode: "100644", type: "blob", sha: null };
        }
        if (change.contentBase64 !== undefined) {
            const blob = await githubJson<{ sha: string }>(cfg, repoPath(cfg, "/git/blobs"), {
                method: "POST",
                body: JSON.stringify({ content: change.contentBase64, encoding: "base64" }),
            });
            return { path: change.path, mode: "100644", type: "blob", sha: blob.sha };
        }
        if (change.content === undefined) {
            throw new Error(`No content supplied for ${change.path}.`);
        }
        return { path: change.path, mode: "100644", type: "blob", content: change.content };
    }));

    const tree = await githubJson<{ sha: string }>(cfg, repoPath(cfg, "/git/trees"), {
        method: "POST",
        body: JSON.stringify({
            base_tree: baseTree,
            tree: entries,
        }),
    });

    const commit = await githubJson<{ sha: string }>(cfg, repoPath(cfg, "/git/commits"), {
        method: "POST",
        body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
    });

    await githubJson(cfg, repoPath(cfg, `/git/refs/heads/${encodeURIComponent(cfg.branch)}`), {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha }),
    });

    return { commit: commit.sha };
}

export async function vaultHealthCheck(): Promise<{
    ok: boolean;
    repo?: string;
    branch?: string;
    canRead: boolean;
    canWrite: boolean;
    detail?: string;
}> {
    const cfg = getVaultConfig();
    if (!cfg) {
        return { ok: false, canRead: false, canWrite: false, detail: "Vault not configured." };
    }

    try {
        const repoInfo = await githubJson<{ permissions?: { push?: boolean } }>(
            cfg,
            repoPath(cfg, ""),
        );
        const canWrite = !!repoInfo.permissions?.push;
        await getFile(cfg, "index.md");
        return {
            ok: canWrite,
            repo: `${cfg.owner}/${cfg.repo}`,
            branch: cfg.branch,
            canRead: true,
            canWrite,
        };
    } catch (err) {
        return {
            ok: false,
            repo: `${cfg.owner}/${cfg.repo}`,
            branch: cfg.branch,
            canRead: false,
            canWrite: false,
            detail: err instanceof Error ? err.message : "Unknown error.",
        };
    }
}
