import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./build-council-check.mts", import.meta.url));
const synthetic = {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-build-anon",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-build-service",
    AUTH_SESSION_SECRET: "synthetic-build-session-secret-32-characters",
    GEMINI_API_KEY: "synthetic-build-gemini",
    CI: "1", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
};
const blocked = {
    OPENAI_API_KEY: "inherited-openai-marker",
    ANTHROPIC_API_KEY: "inherited-anthropic-marker",
    CLAUDE_CODE_OAUTH_TOKEN: "inherited-claude-marker",
    MCP_COUNCIL_HOST_KEY: "inherited-host-marker",
    NVIDIA_API_KEY: "inherited-nvidia-marker",
    GITHUB_TOKEN: "inherited-github-marker",
    DISCORD_TOKEN: "inherited-discord-marker",
    NODE_OPTIONS: "--no-warnings",
    NODE_PATH: "inherited-node-path-marker",
    NPM_CONFIG_NODE_OPTIONS: "--env-file=inherited-env-file-marker",
    DOTENV_CONFIG_PATH: "inherited-dotenv-marker",
    NEXT_PUBLIC_CUSTOM_TOKEN: "inherited-public-marker",
    NEXT_PUBLIC_BASE_URL: "https://inherited-base-marker.invalid",
};
interface Observation { argv: string[]; execPath: string; execArgv: string[]; cwd: string; env: Record<string, string>; pid: number }

function fixture(mode: "ok" | "nonzero" | "signal" | "hold" = "ok", cli = true) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "council-build-check-"));
    const command = join(root, "node_modules", "next", "dist", "bin", "next");
    const record = join(root, "invocation.json");
    if (cli) {
        mkdirSync(dirname(command), { recursive: true });
        writeFileSync(command, `const fs = require('node:fs');
fs.writeFileSync('invocation.json', JSON.stringify({argv:process.argv.slice(2),execPath:process.execPath,execArgv:process.execArgv,cwd:process.cwd(),env:process.env,pid:process.pid}));
for (const value of Object.values(process.env)) if (value.includes('inherited-')) process.stdout.write(value + '\\n');
process.stdout.write('synthetic build completed\\n');
${mode === "nonzero" ? "process.exitCode = 23;" : mode === "signal" ? "process.kill(process.pid, 'SIGTERM');" : mode === "hold" ? "setInterval(() => {}, 100);" : ""}
`);
    }
    const runtimeEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(Object.entries(process.env)
        .filter(([key, value]) => value !== undefined && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|TEMP|TMP)$/i.test(key))) };
    Object.assign(runtimeEnv, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, NO_COLOR: "1" });
    return {
        root, command, record,
        run: (args: string[] = [], env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [entry, ...args], {
            cwd: root, env: { ...runtimeEnv, ...env }, encoding: "utf8", shell: false, timeout: 15_000,
        }),
        start: () => spawn(process.execPath, [entry], { cwd: root, env: runtimeEnv, shell: false, stdio: "ignore" }),
        observed: () => JSON.parse(readFileSync(record, "utf8")) as Observation,
        cleanup: () => {
            assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));
            rmSync(root, { recursive: true, force: true });
        },
    };
}

async function assertStopped(pid: number) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        try { process.kill(pid, 0); }
        catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("The synthetic Next child survived its completed wrapper.");
}

await test("verification build executes only the local Next CLI with fixed synthetic configuration", async t => {
    const f = fixture(); t.after(f.cleanup);
    const result = f.run();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, "The verification wrapper must launch the synthetic local Next CLI successfully.");
    const observed = f.observed();
    assert.deepEqual(observed.argv, ["build"]);
    assert.equal(realpathSync(observed.execPath), realpathSync(process.execPath));
    assert.equal(realpathSync(observed.cwd), realpathSync(f.root));
    assert.deepEqual(observed.execArgv, []);
    for (const [name, value] of Object.entries(synthetic)) assert.equal(observed.env[name], value, name);
    assert.match(result.stdout, /synthetic build completed/);
    await assertStopped(observed.pid);
});

for (const lowerCase of [false, true]) {
    await test(`verification child discards inherited credentials and load options (${lowerCase ? "mixed case" : "canonical case"})`, async t => {
        const f = fixture(); t.after(f.cleanup);
        const inherited = { ...blocked, ...Object.fromEntries(Object.keys(synthetic).map(name => [name, `inherited-${name.toLowerCase()}-marker`])) };
        const env = Object.fromEntries(Object.entries(inherited).map(([name, value]) => [lowerCase ? name.toLowerCase() : name, value]));
        const result = f.run([], env);
        assert.equal(result.status, 0);
        const observed = f.observed();
        const canonical = Object.fromEntries(Object.entries(observed.env).map(([name, value]) => [name.toUpperCase(), value]));
        for (const name of Object.keys(blocked)) assert.equal(canonical[name], undefined, name);
        for (const [name, value] of Object.entries(synthetic)) {
            assert.equal(canonical[name], value, name);
            assert.equal(Object.keys(observed.env).filter(key => key.toUpperCase() === name).length, 1, name);
        }
        assert(!JSON.stringify(observed).includes("inherited-"));
        assert(!(result.stdout + result.stderr).includes("inherited-"));
        await assertStopped(observed.pid);
    });
}

await test("the harmless dotenv example does not block a verification build", async t => {
    const f = fixture(); t.after(f.cleanup);
    writeFileSync(join(f.root, ".env.example"), "AUTH_SESSION_SECRET=inherited-example-marker\n");
    const result = f.run();
    assert.equal(result.status, 0);
    assert(!JSON.stringify(f.observed()).includes("inherited-example-marker"));
    await assertStopped(f.observed().pid);
});

for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    await test(`${name} refuses the build before spawning Next`, t => {
        const f = fixture(); t.after(f.cleanup);
        const content = "SUPABASE_SERVICE_ROLE_KEY=inherited-dotenv-file-marker\n";
        writeFileSync(join(f.root, name), content);
        const result = f.run();
        assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
        assert.equal(existsSync(f.record), false);
        assert.equal(readFileSync(join(f.root, name), "utf8"), content);
        assert(!(result.stdout + result.stderr).includes("inherited-dotenv-file-marker"));
    });
}

await test("dotenv directories also refuse the build before spawning Next", t => {
    const f = fixture(); t.after(f.cleanup);
    mkdirSync(join(f.root, ".env.local"));
    const result = f.run();
    assert.notEqual(result.status, 0); assert.equal(existsSync(f.record), false);
});

await test("a dangling dotenv link refuses the build before spawning Next", t => {
    const f = fixture(); t.after(f.cleanup);
    const target = join(f.root, "missing-env-target");
    const link = join(f.root, ".env.production.local");
    try { symlinkSync(target, link, process.platform === "win32" ? "junction" : "file"); }
    catch (error) {
        if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            t.skip("This platform does not permit creating a dangling fixture link.");
            return;
        }
        throw error;
    }
    assert.equal(existsSync(link), false); assert(lstatSync(link).isSymbolicLink());
    const result = f.run();
    assert.notEqual(result.status, 0); assert.equal(existsSync(f.record), false);
    assert.equal(existsSync(target), false); assert(lstatSync(link).isSymbolicLink());
});

await test("application arguments cannot reach Next or appear in diagnostics", t => {
    const f = fixture(); t.after(f.cleanup);
    for (const args of [["--help"], ["--unexpected", "inherited-argument-marker"], [";echo inherited-argument-marker"]]) {
        const result = f.run(args);
        assert.notEqual(result.status, 0); assert.equal(existsSync(f.record), false);
        assert(!(result.stdout + result.stderr).includes("inherited-argument-marker"));
    }
});

await test("missing local Next CLI fails without searching a global executable", t => {
    const f = fixture("ok", false); t.after(f.cleanup);
    const result = f.run();
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
    assert.equal(existsSync(f.record), false);
});

await test("the exact failing build exit code is propagated and its child ends", async t => {
    const f = fixture("nonzero"); t.after(f.cleanup);
    const result = f.run();
    assert.equal(result.error, undefined); assert.equal(result.status, 23);
    await assertStopped(f.observed().pid);
});

await test("a signalled build cannot report success or leave its child running", async t => {
    const f = fixture("signal"); t.after(f.cleanup);
    const result = f.run();
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
    await assertStopped(f.observed().pid);
});

await test("the standard verification profile uses the isolated wrapper and preserves the production build command", () => {
    const profile = JSON.parse(readFileSync(new URL("../.zuychin/council-verification.json", import.meta.url), "utf8"));
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.deepEqual(profile.profiles.standard.commands.at(-1).command, ["node", "--import", "tsx", "scripts/build-council-check.mts"]);
    assert.equal(pkg.scripts.build, "next build");
});

await test("POSIX parent termination is forwarded and waits for the synthetic Next child", async t => {
    if (process.platform === "win32") {
        t.skip("Windows force termination requires the host's outer process-tree cleanup.");
        return;
    }
    const f = fixture("hold");
    const wrapper = f.start();
    let childPid: number | undefined;
    t.after(async () => {
        wrapper.kill("SIGKILL");
        if (childPid) {
            try { process.kill(childPid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            await assertStopped(childPid);
        }
        f.cleanup();
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        wrapper.once("error", reject);
        wrapper.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const readyDeadline = Date.now() + 5_000;
    while (childPid === undefined) {
        try { childPid = f.observed().pid; }
        catch (error) {
            if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (childPid !== undefined) break;
        assert(Date.now() < readyDeadline, "Synthetic Next never started.");
        assert.equal(wrapper.exitCode, null);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(wrapper.kill("SIGTERM"));
    const timeout = setTimeout(() => wrapper.kill("SIGKILL"), 5_000);
    try {
        const result = await exited;
        assert.notEqual(result.code, 0);
        assert.equal(result.signal, null, "The wrapper must wait for its child before exiting.");
        await assertStopped(childPid);
        childPid = undefined;
    } finally { clearTimeout(timeout); }
});
