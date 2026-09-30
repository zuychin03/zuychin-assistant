import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [directory, mode] = process.argv.slice(2);
const trace = join(directory, `${process.pid}.jsonl`);
const record = (value) => appendFileSync(trace, JSON.stringify(value) + "\n");
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
record({ pid: process.pid, cwd: process.cwd() });
setTimeout(() => process.exit(93), 60_000).unref();

let selectedModel = "alpha";
let selectedReasoning = "medium";
const config = () => ({ configOptions: [
    { id: "fixture-model", category: "model", type: "select", name: "Model", currentValue: selectedModel,
        options: ["alpha", "beta"].map((value) => ({ value, name: value })) },
    { id: "fixture-effort", category: "thought_level", type: "select", name: "Reasoning", currentValue: selectedReasoning,
        options: ["medium", "high"].map((value) => ({ value, name: value })) },
] });

for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    record({ method: request.method, ...(request.method === "session/set_config_option" ? {
        configId: request.params.configId, value: request.params.value,
    } : request.method === "session/set_model" ? { modelId: request.params.modelId } : {}) });
    if (request.method === "initialize") {
        send({ id: request.id, result: { protocolVersion: request.params.protocolVersion,
            agentCapabilities: {}, authMethods: [], agentInfo: { name: "model-evidence-fixture", version: "observed-1.2.3" } } });
    } else if (request.method === "session/new") {
        send({ id: request.id, result: { sessionId: `fixture-${process.pid}`, ...(mode.startsWith("legacy") ? {
            models: { currentModelId: "default", availableModels: [
                { modelId: "default", name: "Default" }, { modelId: "sonnet", name: "Sonnet" },
            ] },
        } : config()) } });
    } else if (request.method === "session/set_model") {
        if (mode === "legacy-timeout") continue;
        if (mode === "legacy-error") {
            send({ id: request.id, error: { code: -32602, message: "Legacy fixture rejected model" } });
        } else {
            selectedModel = request.params.modelId;
            send({ id: request.id, result: mode === "legacy-malformed" ? [] : {} });
        }
    } else if (request.method === "session/set_config_option") {
        if (request.params.configId === "fixture-model") {
            if (mode !== "wrong-model") selectedModel = request.params.value;
        } else if (request.params.configId === "fixture-effort") {
            selectedReasoning = request.params.value;
            if (mode === "wrong-final") selectedModel = "alpha";
        }
        send({ id: request.id, result: mode === "missing-model" ? {} : config() });
    } else if (request.method === "session/prompt") {
        send({ id: request.id, result: { stopReason: "end_turn" } });
    } else if (request.id !== undefined) {
        send({ id: request.id, error: { code: -32601, message: "Unsupported fixture method" } });
    }
}
