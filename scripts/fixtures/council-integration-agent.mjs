import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { createInterface } from "node:readline";

const [trace, livenessPort] = process.argv.slice(2);
const record = (value) => appendFileSync(trace, JSON.stringify(value) + "\n");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
let cwd;
// Held open for the process lifetime: the suite proves this adapter exited by
// the socket closing, because a recorded PID can be recycled by another process.
if (livenessPort) {
    const liveness = connect(Number(livenessPort), "127.0.0.1");
    await once(liveness, "connect");
    liveness.on("error", () => {});
    liveness.write(String(process.pid));
    liveness.unref();
}
record({ pid: process.pid });
setTimeout(() => process.exit(93), 100_000).unref();
for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method === "initialize") send(request.id, { protocolVersion: request.params.protocolVersion,
        agentCapabilities: {}, authMethods: [], agentInfo: { name: "integration-fixture", version: "1.0.0" } });
    if (request.method === "session/new") {
        cwd = request.params.cwd;
        send(request.id, { sessionId: "fixture-session" });
    }
    if (request.method === "session/prompt") {
        const prompt = request.params.prompt.map((block) => block.text ?? "").join("");
        record({ prompt, cwd });
        if (prompt.includes("You are the nominated integrator")) {
            for (const [, sha] of prompt.matchAll(/^- ([0-9a-f]{40})$/gm)) {
                execFileSync("git", ["merge", "--no-edit", sha], { cwd, stdio: ["ignore", "pipe", "pipe"] });
            }
        }
        send(request.id, { stopReason: "end_turn" });
    }
}
