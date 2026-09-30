import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { buildCouncilAdapterEnv } from "./council-adapter-env.mts";

try {
    if (process.argv.length !== 2) throw new Error("Council verification build accepts no arguments.");
    const cwd = process.cwd();
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
        let present = false;
        try {
            lstatSync(join(cwd, name));
            present = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw new Error(`Cannot inspect ${name} before the Council verification build.`);
            }
        }
        if (present) throw new Error(`Council verification build refuses ${name}; use a clean checkout.`);
    }

    const env = {
        ...buildCouncilAdapterEnv(process.env, { CI: "1", NODE_ENV: "production" }),
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-build-anon",
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-build-service",
        AUTH_SESSION_SECRET: "synthetic-build-session-secret-32-characters",
        GEMINI_API_KEY: "synthetic-build-gemini",
        NEXT_TELEMETRY_DISABLED: "1",
    };
    console.log("Council verification: synthetic build settings; hosted services are not tested.");
    process.exitCode = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [join(cwd, "node_modules", "next", "dist", "bin", "next"), "build"], {
            cwd, env, shell: false, windowsHide: true, stdio: "inherit",
        });
        let interrupted = false;
        const forwardInterrupt = () => { interrupted = true; child.kill("SIGINT"); };
        const forwardTermination = () => { interrupted = true; child.kill("SIGTERM"); };
        process.on("SIGINT", forwardInterrupt);
        process.on("SIGTERM", forwardTermination);
        const finish = (code: number) => {
            process.removeListener("SIGINT", forwardInterrupt);
            process.removeListener("SIGTERM", forwardTermination);
            resolve(interrupted ? 1 : code);
        };
        child.once("error", () => {
            console.error("Could not start the Council verification build.");
            finish(1);
        });
        child.once("close", (code) => finish(code ?? 1));
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : "Council verification build failed.");
    process.exitCode = 1;
}
