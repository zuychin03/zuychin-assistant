import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [trace, mode] = process.argv.slice(2);
writeFileSync(trace, JSON.stringify({ env: process.env, args: process.argv.slice(2) }) + "\n");
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let model = "fixture-default";
let reasoning = "low";
const configOptions = () => [
    { id: "fixture-model", category: "model", name: "Model", type: "select", currentValue: model,
        options: [{ value: "fixture-default", name: "Default" }, { value: "fixture-next", name: "Next" }] },
    { id: model === "fixture-next" ? "next-effort" : "default-effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: reasoning,
        options: (model === "fixture-next" ? ["low", "high"] : ["low"]).map((value) => ({ value, name: value })) },
];
for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    appendFileSync(trace, JSON.stringify(request) + "\n");
    if (request.method === "initialize") {
        send({ id: request.id, result: { protocolVersion: mode === "mismatch" ? 999 : request.params.protocolVersion,
            agentCapabilities: {}, authMethods: [], agentInfo: { name: "fixture-adapter", version: "1.2.3-fixture" } } });
    } else if (request.method === "session/new") {
        const key = request.params.mcpServers[0]?.headers[0]?.value ?? "";
        if (mode === "error") {
            process.stderr.write(key + "\n");
            send({ id: request.id, error: { code: -32603, message: "fixture error " + key } });
        } else {
            globalThis.fixtureKey = key;
            if (mode === "invalid-rpc") send({ fixture: key });
            if (mode === "unknown-response") send({ id: key, result: {} });
            send({ id: request.id, result: { sessionId: "fixture-session", ...(mode.startsWith("legacy-") ? {
                models: { ...(mode === "legacy-no-current" ? {} : { currentModelId: "claude-fixture" }), availableModels: [
                    { modelId: "claude-fixture", name: "Claude fixture" }, { modelId: "claude-next", name: "Claude next" },
                ] },
                ...(mode === "legacy-reasoning" ? { configOptions: configOptions().filter((option) => option.category === "thought_level") } : {}),
            } : mode.startsWith("selection-") ? { configOptions: configOptions() } : {}) } });
        }
    } else if (request.method === "session/set_model") {
        send({ id: request.id, ...(mode === "legacy-reject"
            ? { error: { code: -32602, message: "fixture model selection rejected" } }
            : { result: mode === "legacy-invalid" ? null : {} }) });
    } else if (request.method === "session/set_config_option") {
        if (request.params.configId === "fixture-model") {
            if (mode !== "selection-wrong") model = request.params.value;
        } else if (request.params.configId === (model === "fixture-next" ? "next-effort" : "default-effort")) {
            reasoning = request.params.value;
            if (mode === "selection-drift") model = "fixture-default";
        } else {
            send({ id: request.id, error: { code: -32602, message: "unadvertised config ID" } });
            continue;
        }
        send({ id: request.id, result: mode === "selection-missing" ? {} : { configOptions: configOptions() } });
    } else if (request.method === "session/prompt") {
        if (mode === "notification-error") {
            send({ method: "session/update", params: { sessionId: "fixture-session", fixture: globalThis.fixtureKey,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: 42 } } } });
        }
        const text = mode === "none" ? "NO MCP TOOLS" : mode === "ambiguous" ? "I cannot tell which server has tools."
            : mode === "negative" ? "I cannot see search_knowledge or list_notes."
                : mode === "echo" ? globalThis.fixtureKey + "\nMCP_TOOLS: search_knowledge, list_notes, vault_read"
                    : "MCP_TOOLS: search_knowledge, list_notes, vault_read";
        send({ method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
        if (mode === "edit") {
            globalThis.fixturePromptId = request.id;
            send({ id: "fixture-write", method: "fs/write_text_file", params: { sessionId: "fixture-session", path: "probe.txt", content: "ok" } });
        } else send({ id: request.id, result: { stopReason: "end_turn" } });
    } else if (request.id === "fixture-write") {
        send({ id: globalThis.fixturePromptId, result: { stopReason: "end_turn" } });
    }
}
