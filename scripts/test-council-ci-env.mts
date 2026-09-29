import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createCiEnvironment, parseCiOptions, prepareCiEnvironment } from "./prepare-council-ci.mts";

const fixture = { API_URL: "http://127.0.0.1:54321", ANON_KEY: "fixture.anon-key", SERVICE_ROLE_KEY: "fixture.service-key" };
let passed = 0;
function check(name: string, test: () => void): void {
    test();
    passed++;
    console.log(`ok ${name}`);
}

for (const url of ["http://127.0.0.1:54321", "http://localhost:54321/", "http://[::1]:54321", "http://127.0.0.1"]) {
    check("loopback status produces an isolated, parseable environment", () => {
        const env = parseEnv(createCiEnvironment({ ...fixture, API_URL: url, DATABASE_URL: "ignored-fixture-value" }));
        assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, new URL(url).origin);
        assert.equal(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, fixture.ANON_KEY);
        assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, fixture.SERVICE_ROLE_KEY);
        assert.equal(env.NEXT_PUBLIC_BASE_URL, "http://127.0.0.1:3105");
        assert.equal(env.GEMINI_API_KEY, "ci-import-placeholder");
        assert(env.AUTH_SESSION_SECRET);
        assert(env.MCP_COUNCIL_HOST_KEY);
        assert.match(env.AUTH_SESSION_SECRET, /^[a-f0-9]{64}$/);
        assert.match(env.MCP_COUNCIL_HOST_KEY, /^[a-f0-9]{64}$/);
        assert.notEqual(env.AUTH_SESSION_SECRET, env.MCP_COUNCIL_HOST_KEY);
        assert.equal(Object.keys(env).length, 7);
    });
}
check("session and host secrets change between runs", () => {
    const first = parseEnv(createCiEnvironment(fixture));
    const second = parseEnv(createCiEnvironment(fixture));
    assert.notEqual(first.AUTH_SESSION_SECRET, second.AUTH_SESSION_SECRET);
    assert.notEqual(first.MCP_COUNCIL_HOST_KEY, second.MCP_COUNCIL_HOST_KEY);
});
for (const url of [
    "https://127.0.0.1:54321", "http://project.supabase.co", "http://localhost.example.com", "http://192.168.1.1",
    "http://127.0.0.2", "http://2130706433", "http://127.1", "http://0x7f000001", "file:///tmp/status",
    "http://user:private-marker@localhost", "http://localhost?key=private-marker", "http://localhost#private-marker",
    "http://localhost?", "http://localhost#", "http://localhost/private-marker", "http://localhost/..", "http://localhost//",
    "http://localhost:\\private-marker", "http://localhost:", "http://localhost:65536", " http://localhost", "http://localhost\n",
]) {
    check("non-local or decorated endpoints are rejected without echoing input", () => {
        assert.throws(() => createCiEnvironment({ ...fixture, API_URL: url }), (error: unknown) => {
            assert(error instanceof Error);
            assert(!error.message.includes(url));
            assert(!error.message.includes("private-marker"));
            return true;
        });
    });
}
for (const value of [null, [], "private-marker", 42, {}, { ...fixture, API_URL: null }]) {
    check("malformed status objects cannot generate environment files", () => assert.throws(() => createCiEnvironment(value)));
}
for (const name of ["ANON_KEY", "SERVICE_ROLE_KEY"]) {
    for (const value of [undefined, null, "", " ", 42, "valid\nINJECTED=private-marker", "valid\rINJECTED=private-marker", "bad\0key", "key #comment", 'key"suffix', "${INJECTED}", "key\\suffix"]) {
        check("missing or unsafe credentials cannot inject environment entries", () => {
            assert.throws(() => createCiEnvironment({ ...fixture, [name]: value }), (error: unknown) => {
                assert(error instanceof Error);
                assert(!error.message.includes("private-marker"));
                return true;
            });
        });
    }
}
check("CLI options accept explicit input and output paths", () => assert.deepEqual(
    parseCiOptions(["--output", "output.env", "--status-file", "status.json"]),
    { statusFile: "status.json", envFile: "output.env" },
));
for (const args of [[], ["--status-file", "input"], ["--output", "output"], ["--unknown", "private-marker"], ["--status-file"],
    ["--status-file", "input", "--status-file", "other", "--output", "output"],
    ["--status-file", "input", "--output", "output", "--output", "other"],
    ["--status-file", "--output", "output"], ["--status-file", "input", "--output", "bad\0path"],
]) {
    check("invalid options fail without exposing arguments", () => assert.throws(() => parseCiOptions(args), (error: unknown) => {
        assert(error instanceof Error);
        assert(!error.message.includes("private-marker"));
        return true;
    }));
}

const root = mkdtempSync(join(realpathSync(tmpdir()), "council-ci-env-"));
const statusFile = join(root, "status.json");
const envFile = join(root, "ci.env");
const entry = fileURLToPath(new URL("./prepare-council-ci.mts", import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const run = (args: string[]) => spawnSync(process.execPath, ["--import", loader, entry, ...args], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, AUTH_SESSION_SECRET: "inherited-secret-marker", MCP_COUNCIL_HOST_KEY: "inherited-host-marker" },
});
try {
    writeFileSync(statusFile, JSON.stringify(fixture));
    writeFileSync(join(root, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL=https://must-not-be-read.invalid\nAUTH_SESSION_SECRET=local-secret-marker\n");
    check("CLI writes only the supplied local status and does not log keys", () => {
        const result = run(["--status-file", statusFile, "--output", envFile]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.stderr, "");
        const env = parseEnv(readFileSync(envFile, "utf8"));
        assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, fixture.API_URL);
        assert(!Object.values(env).some((value) => value?.includes("inherited-") || value?.includes("local-secret-marker")));
        for (const secret of [fixture.ANON_KEY, fixture.SERVICE_ROLE_KEY, env.AUTH_SESSION_SECRET, env.MCP_COUNCIL_HOST_KEY]) {
            assert(secret);
            assert(!(result.stdout + result.stderr).includes(secret));
        }
        if (process.platform !== "win32") assert.equal(statSync(envFile).mode & 0o777, 0o600);
    });
    check("existing environment files are preserved byte for byte", () => {
        const before = readFileSync(envFile);
        assert.throws(() => prepareCiEnvironment({ statusFile, envFile }));
        assert.deepEqual(readFileSync(envFile), before);
    });
    check("malformed JSON is rejected without copying raw input into errors", () => {
        const malformed = join(root, "malformed.json");
        writeFileSync(malformed, '{"private-marker":');
        const result = run(["--status-file", malformed, "--output", join(root, "malformed.env")]);
        assert.equal(result.status, 1);
        assert(!result.stderr.includes("private-marker"));
        assert(!existsSync(join(root, "malformed.env")));
    });
    check("oversized status input fails before creating an output", () => {
        const oversized = join(root, "oversized.json");
        writeFileSync(oversized, JSON.stringify({ ...fixture, padding: "x".repeat(65_536) }));
        const output = join(root, "oversized.env");
        assert.throws(() => prepareCiEnvironment({ statusFile: oversized, envFile: output }));
        assert(!existsSync(output));
    });
    for (const options of [
        { statusFile: join(root, "private-marker-missing.json"), envFile: join(root, "missing.env") },
        { statusFile: root, envFile: join(root, "directory.env") },
        { statusFile, envFile: join(root, "private-marker-missing", "ci.env") },
        { statusFile, envFile: root },
    ]) {
        check("file-system failures do not disclose paths or raw errors", () => {
            const result = run(["--status-file", options.statusFile, "--output", options.envFile]);
            assert.equal(result.status, 1);
            assert(!result.stderr.includes("private-marker"));
            assert(!result.stderr.includes(root));
            assert(!result.stderr.includes("ENOENT"));
            assert(!result.stderr.includes("EISDIR"));
        });
    }
    check("existing symlinks cannot redirect environment writes", () => {
        const target = join(root, "symlink-target");
        const link = join(root, "symlink.env");
        if (process.platform === "win32") {
            mkdirSync(target);
            symlinkSync(target, link, "junction");
            assert.throws(() => prepareCiEnvironment({ statusFile, envFile: link }));
            assert(statSync(target).isDirectory());
        } else {
            writeFileSync(target, "preserve fixture");
            symlinkSync(target, link);
            assert.throws(() => prepareCiEnvironment({ statusFile, envFile: link }));
            assert.equal(readFileSync(target, "utf8"), "preserve fixture");
            const dangling = join(root, "dangling.env");
            symlinkSync(join(root, "missing-target"), dangling);
            assert.throws(() => prepareCiEnvironment({ statusFile, envFile: dangling }));
            assert(!existsSync(join(root, "missing-target")));
        }
    });
    console.log(`\n${passed} Council CI environment checks passed.`);
} finally {
    assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));
    rmSync(root, { recursive: true, force: true });
}
