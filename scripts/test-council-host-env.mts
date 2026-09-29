import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { buildCouncilAdapterEnv } from "./council-adapter-env.mts";

const source = readFileSync(new URL("./council-host.mts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("host.ts", source, ts.ScriptTarget.ESNext, true);
const names = ["adapterEnv", "createTerminal", "git", "gitAsync", "verifyIntegration"];
const functions = parsed.statements.filter((node) => ts.isFunctionDeclaration(node)
    && node.name && names.includes(node.name.text)).map((node) => node.getText(parsed));
assert.equal(functions.length, names.length);
const compiled = ts.transpileModule(functions.join("\n"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const parentEnv = {
    NODE_ENV: "test", PATH: "/fixture/bin", HOME: "/fixture/home",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-secret", AUTH_SESSION_SECRET: "synthetic-session-secret",
    MCP_COUNCIL_HOST_KEY: "synthetic-host-secret", MCP_API_KEY: "synthetic-owner-secret",
    COUNCIL_PROBE_MCP_KEY: "synthetic-probe-secret", NODE_OPTIONS: "--require /fixture/preload.js",
};
let captured: { env?: Record<string, string>; cwd?: string } = {};
let verificationEnv: Record<string, string> | undefined;
const sandbox = {
    process: { env: parentEnv }, buildCouncilAdapterEnv, randomUUID: () => "fixture-terminal",
    TERMINAL_OUTPUT_LIMIT: 4096, terminals: new Map(), broadcast: () => {},
    createHash, setTimeout, clearTimeout, killTree: () => {}, resolve,
    state: { repo: "/fixture/repo", code: "CN-TEST", baseBranch: "main", verifyCommand: ["fixture-verify"] },
    spawnResolved(_command: string, _args: string[], options: typeof captured) {
        captured = options;
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0));
        return child;
    },
    spawnSync(command: string, _args: string[], options: typeof captured) {
        captured = options;
        if (command === "fixture-verify") verificationEnv = options.env;
        return { status: 0, stdout: "fixture", stderr: "" };
    },
};
const host = vm.runInNewContext(`${compiled}\n({ adapterEnv, createTerminal, git, gitAsync, verifyIntegration })`, sandbox) as {
    adapterEnv: (agent: unknown) => Record<string, string>;
    createTerminal: (agent: unknown, params: unknown) => unknown;
    git: (repo: string, args: string[]) => unknown;
    gitAsync: (repo: string, args: string[]) => Promise<unknown>;
    verifyIntegration: (branches: string[]) => unknown;
};
let passed = 0;
let failed = 0;
function check(name: string, test: () => void): void {
    try { test(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${(error as Error).message}`); }
}
function assertPrivate(env: Record<string, string> | undefined): void {
    assert(env, "The child must receive an explicit reduced environment");
    assert.equal(env.PATH, parentEnv.PATH);
    assert.equal(env.HOME, parentEnv.HOME);
    for (const [name, value] of Object.entries(env)) {
        assert(!/^(SUPABASE_|AUTH_|MCP_COUNCIL_|COUNCIL_PROBE_|NODE_OPTIONS$)/i.test(name), `Unexpected privileged variable: ${name}`);
        assert(!Object.entries(parentEnv).some(([key, secret]) => /KEY|SECRET/.test(key) && value.includes(secret)), `Unexpected inherited credential in ${name}`);
    }
}
const agent = {
    name: "fixture-agent", treeDir: "/fixture/worktree", seatToken: "synthetic-seat-token",
    adapter: { env: { AUTH_SESSION_SECRET: "override-secret", mcp_api_key: "forged-seat", MCP_COUNCIL_HOST_KEY: "override-host" } },
};
check("adapter receives only its host-issued seat credential", () => {
    const env = host.adapterEnv(agent);
    assertPrivate(env);
    assert.equal(env.MCP_API_KEY, agent.seatToken);
    assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === "MCP_API_KEY").length, 1);
});
check("adapter without a seat cannot inherit knowledge credentials", () => {
    const env = host.adapterEnv({ ...agent, seatToken: undefined });
    assertPrivate(env);
    assert(!Object.keys(env).some((key) => key.toUpperCase() === "MCP_API_KEY"));
});
check("terminal cannot inherit or override server credentials", () => {
    host.createTerminal(agent, { command: "fixture", env: [
        { name: "AUTH_SESSION_SECRET", value: "override-secret" },
        { name: "MCP_API_KEY", value: "forged-seat" },
        { name: "BUILD_MODE", value: "fixture" },
    ] });
    assertPrivate(captured.env);
    assert.equal(captured.cwd, agent.treeDir);
    assert.equal(captured.env?.MCP_API_KEY, undefined);
    assert.equal(captured.env?.BUILD_MODE, "fixture");
});
check("synchronous Git does not inherit server credentials", () => {
    host.git("/fixture/repo", ["status"]);
    assertPrivate(captured.env);
    assert.equal(captured.env?.MCP_API_KEY, undefined);
});
await host.gitAsync("/fixture/repo", ["status"]);
check("asynchronous Git does not inherit server credentials", () => {
    assertPrivate(captured.env);
    assert.equal(captured.env?.MCP_API_KEY, undefined);
});
check("legacy integration verification does not inherit server credentials", () => {
    host.verifyIntegration([]);
    assertPrivate(verificationEnv);
});
const gitSource = ts.createSourceFile("git.ts", readFileSync(new URL("./council-git.mts", import.meta.url), "utf8"), ts.ScriptTarget.ESNext, true);
const gitFunctions = gitSource.statements.filter((node) => ts.isFunctionDeclaration(node)
    && node.name && ["git", "gitAsync", "runCommand"].includes(node.name.text));
assert.equal(gitFunctions.length, 3);
const gitCompiled = ts.transpileModule(gitFunctions.map((node) => node.getText(gitSource)).join("\n"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const verifier = vm.runInNewContext(`${gitCompiled}\n({ git, gitAsync, runCommand })`, sandbox) as {
    git: (repo: string, args: string[]) => unknown;
    gitAsync: (repo: string, args: string[]) => Promise<unknown>;
    runCommand: (cwd: string, entry: unknown, limit: number) => Promise<unknown>;
};
check("verification Git does not inherit server credentials", () => {
    verifier.git("/fixture/repo", ["status"]);
    assertPrivate(captured.env);
});
await verifier.gitAsync("/fixture/repo", ["status"]);
check("verification worktree Git does not inherit server credentials", () => assertPrivate(captured.env));
await verifier.runCommand("/fixture/repo", { command: ["fixture-build"] }, 4096);
check("agent-authored build commands receive no server credentials", () => {
    assertPrivate(captured.env);
    assert.equal(captured.env?.CI, "1");
    assert.equal(captured.env?.MCP_API_KEY, undefined);
});
console.log(`${passed} host environment checks passed; ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
