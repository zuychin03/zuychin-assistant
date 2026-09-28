import assert from "node:assert/strict";
import { listVaultFileRevisions, isVaultCommitAncestor, getFile, commitFiles, VaultConflictError } from "../src/lib/vault/github";

const cfg = { owner: "fixture", repo: "vault", branch: "main", token: "fixture-token" };
const oldSha = "a".repeat(40), head = "b".repeat(40);
const previous = globalThis.fetch;
const urls: URL[] = [];
try {
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input)); urls.push(url);
        assert.equal(url.hostname, "api.github.com");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
        assert.ok(init?.signal);
        if (url.pathname.endsWith("/commits")) return Response.json([{ sha: oldSha, commit: { message: "Earlier revision\nprivate body", author: { name: "Fixture", date: "2026-09-01T00:00:00Z" } } }]);
        if (url.pathname.includes("/compare/")) return Response.json({ status: url.pathname.includes(`${oldSha}...${head}`) ? "ahead" : "diverged" });
        throw new Error("Unexpected offline GitHub request");
    };
    const result = await listVaultFileRevisions(cfg, "notes/some page.md", head, 2);
    assert.equal(result.revisions[0].commitSha, oldSha);
    assert.equal(result.revisions[0].message, "Earlier revision");
    assert.equal(urls[0].searchParams.get("path"), "notes/some page.md");
    assert.equal(urls[0].searchParams.get("sha"), head);
    assert.equal(urls[0].searchParams.get("page"), "2");
    assert.equal(await isVaultCommitAncestor(cfg, oldSha, head), true);
    assert.equal(await isVaultCommitAncestor(cfg, "c".repeat(40), head), false);
    assert.equal(await isVaultCommitAncestor(cfg, head, head), true);
    assert.equal(urls.length, 3);
    console.log("PASS GitHub revision adapter pins repository/head/path and validates ancestry using offline transport");
    globalThis.fetch = async () => Response.json({ type: "file", sha: oldSha, encoding: "none", content: "" });
    await assert.rejects(getFile(cfg, "large.md", oldSha, undefined, true), /content/i);
    globalThis.fetch = async () => Response.json([{ type: "file", sha: oldSha }]);
    await assert.rejects(getFile(cfg, "directory.md", oldSha, undefined, true), /content/i);
    console.log("PASS strict immutable reads reject unsupported content instead of treating it as empty");
    let conflict = false;
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (url.pathname.endsWith(`/git/commits/${head}`)) return Response.json({ tree: { sha: "d".repeat(40) } });
        if (url.pathname.endsWith("/git/trees")) {
            assert.equal(body.base_tree, "d".repeat(40));
            assert.deepEqual(body.tree, [{ path: "notes/example.md", mode: "100644", type: "blob", content: "Restored body" }]);
            return Response.json({ sha: "e".repeat(40) });
        }
        if (url.pathname.endsWith("/git/commits")) { assert.deepEqual(body.parents, [head]); return Response.json({ sha: "c".repeat(40) }); }
        assert.ok(url.pathname.endsWith("/git/refs/heads/main")); assert.equal(init?.method, "PATCH"); assert.equal(body.force, false);
        return conflict ? Response.json({ message: "not a fast forward" }, { status: 422 }) : Response.json({ object: { sha: body.sha } });
    };
    assert.deepEqual(await commitFiles(cfg, [{ path: "notes/example.md", content: "Restored body" }], "restore", head), { commit: "c".repeat(40) });
    conflict = true;
    await assert.rejects(commitFiles(cfg, [{ path: "notes/example.md", content: "Restored body" }], "restore", head), VaultConflictError);
    console.log("PASS restore creates a child commit with non-forced ref update and rejects concurrent history changes");
} finally { globalThis.fetch = previous; }
