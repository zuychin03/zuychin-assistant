import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const [trace, mode] = process.argv.slice(2);
const record = (value) => appendFileSync(trace, JSON.stringify(value) + "\n");
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
record({ pid: process.pid, tokenHash: createHash("sha256").update(process.env.MCP_API_KEY ?? "").digest("hex") });
setTimeout(() => process.exit(93), 45_000).unref();
if (mode === "expired-shell" || mode === "binding-shell") setInterval(() => {}, 1_000);
let selectedModel = "alpha";
let selectedReasoning = "medium";
const config = () => ({ configOptions: [
    { id: "model", category: "model", type: "select", name: "Model", currentValue: selectedModel,
        options: ["alpha", "beta"].map((value) => ({ value, name: value })) },
    { id: "effort", category: "thought_level", type: "select", name: "Reasoning", currentValue: selectedReasoning,
        options: ["medium", "high"].map((value) => ({ value, name: value })) },
] });

for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    record({ method: request.method, configId: request.params?.configId, value: request.params?.value,
        ...(request.method === "session/prompt" ? { prompt: request.params.prompt.map((block) => block.text ?? "").join("") } : {}) });
    if (request.method === "initialize" && mode !== "hang-initialize") {
        send({ id: request.id, result: { protocolVersion: mode === "wrong-protocol" ? 999 : request.params.protocolVersion,
            agentCapabilities: {}, authMethods: [], agentInfo: { name: "lifecycle-fixture", version: "1.0.0" } } });
    } else if (request.method === "session/new" && mode !== "hang-session") {
        send({ id: request.id, result: { sessionId: "fixture-session", ...config() } });
    } else if (request.method === "session/set_config_option" && mode !== "hang-selection") {
        if (request.params.configId === "model" && mode !== "reject" && mode !== "expired-failed") selectedModel = request.params.value;
        if (request.params.configId === "effort") selectedReasoning = request.params.value;
        send({ id: request.id, result: config() });
    } else if (request.method === "session/prompt" && mode !== "expired-busy" && mode !== "expired-unhealthy"
        && !(mode === "binding-integration" && request.params.prompt.some((block) => block.text?.includes("You are the nominated integrator")))) {
        send({ id: request.id, result: { stopReason: "end_turn" } });
    }
}
