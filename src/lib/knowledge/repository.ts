import {
    commitFiles, getFile, listDir, requireVaultConfig,
    type CommitFileChange,
} from "@/lib/vault/github";

export interface KnowledgeSourceFile {
    path: string;
    markdown: string;
    sha: string;
}

export interface KnowledgeRepository {
    read(path: string): Promise<KnowledgeSourceFile | null>;
    listMarkdown(): Promise<KnowledgeSourceFile[]>;
    commit(changes: CommitFileChange[], message: string): Promise<{ commit: string }>;
}

export class GitHubVaultRepository implements KnowledgeRepository {
    async read(path: string): Promise<KnowledgeSourceFile | null> {
        const file = await getFile(requireVaultConfig(), path);
        return file ? { path: file.path, markdown: file.text, sha: file.sha } : null;
    }

    async listMarkdown(): Promise<KnowledgeSourceFile[]> {
        const cfg = requireVaultConfig();
        const pending = [""];
        const files: KnowledgeSourceFile[] = [];
        while (pending.length) {
            const directory = pending.pop()!;
            for (const entry of await listDir(cfg, directory)) {
                if (entry.type === "dir") pending.push(entry.path);
                else if (entry.name.toLowerCase().endsWith(".md")) {
                    const file = await getFile(cfg, entry.path);
                    if (file) files.push({ path: file.path, markdown: file.text, sha: file.sha });
                }
            }
        }
        return files;
    }

    commit(changes: CommitFileChange[], message: string): Promise<{ commit: string }> {
        return commitFiles(requireVaultConfig(), changes, message);
    }
}
