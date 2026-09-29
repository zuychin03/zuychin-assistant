import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CiOptions {
    statusFile: string;
    envFile: string;
}

class CiEnvironmentError extends Error {}

export function parseCiOptions(args: string[]): CiOptions {
    const options = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const option = args[index];
        const value = args[index + 1];
        if (!["--status-file", "--output"].includes(option) || options.has(option)
            || !value || value.startsWith("--") || /[\u0000-\u001f\u007f]/.test(value)) {
            throw new CiEnvironmentError("Use --status-file <json> --output <new-file> exactly once each.");
        }
        options.set(option, value);
    }
    const statusFile = options.get("--status-file");
    const envFile = options.get("--output");
    if (!statusFile || !envFile) throw new CiEnvironmentError("Both --status-file and --output are required.");
    return { statusFile, envFile };
}

export function createCiEnvironment(status: unknown): string {
    if (!status || typeof status !== "object" || Array.isArray(status)) {
        throw new CiEnvironmentError("Supabase status must be a JSON object.");
    }
    const values = status as Record<string, unknown>;
    const apiUrl = values.API_URL;
    if (typeof apiUrl !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/.test(apiUrl)) {
        throw new CiEnvironmentError("Supabase API_URL must be an HTTP loopback origin without credentials, path, query or fragment.");
    }
    let origin: string;
    try {
        origin = new URL(apiUrl).origin;
    } catch {
        throw new CiEnvironmentError("Supabase API_URL has an invalid port.");
    }
    for (const key of ["ANON_KEY", "SERVICE_ROLE_KEY"]) {
        if (typeof values[key] !== "string" || !/^[A-Za-z0-9._~+\/=-]+$/.test(values[key])) {
            throw new CiEnvironmentError(`Supabase ${key} must be a nonempty single-line token.`);
        }
    }
    return Object.entries({
        NEXT_PUBLIC_SUPABASE_URL: origin,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: values.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: values.SERVICE_ROLE_KEY,
        AUTH_SESSION_SECRET: randomBytes(32).toString("hex"),
        MCP_COUNCIL_HOST_KEY: randomBytes(32).toString("hex"),
        NEXT_PUBLIC_BASE_URL: "http://127.0.0.1:3105",
        GEMINI_API_KEY: "ci-import-placeholder",
    }).map(([key, value]) => `${key}=${value}\n`).join("");
}

function readStatus(statusFile: string): unknown {
    let contents: string;
    try {
        const fd = openSync(statusFile, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        try {
            const sizeLimit = 65_536;
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > sizeLimit) throw new Error();
            const buffer = Buffer.alloc(sizeLimit + 1);
            let count = 0;
            while (count < buffer.length) {
                const bytes = readSync(fd, buffer, count, buffer.length - count, null);
                if (bytes === 0) break;
                count += bytes;
            }
            if (count > sizeLimit) throw new Error();
            contents = buffer.subarray(0, count).toString("utf8");
        } finally {
            closeSync(fd);
        }
    } catch {
        throw new CiEnvironmentError("Cannot read Supabase status: provide a regular JSON file no larger than 64 KiB.");
    }
    try {
        return JSON.parse(contents);
    } catch {
        throw new CiEnvironmentError("Supabase status is not valid JSON.");
    }
}

export function prepareCiEnvironment(options: CiOptions): void {
    const environment = createCiEnvironment(readStatus(options.statusFile));
    try {
        writeFileSync(options.envFile, environment, { flag: "wx", mode: 0o600 });
    } catch {
        throw new CiEnvironmentError("Cannot create the CI environment file. It must not already exist and its parent must be writable.");
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        prepareCiEnvironment(parseCiOptions(process.argv.slice(2)));
        console.log("Isolated Council CI environment created.");
    } catch (error) {
        console.error(error instanceof CiEnvironmentError ? error.message : "Council CI environment setup failed.");
        process.exitCode = 1;
    }
}
