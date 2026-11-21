/**
 * A stand-in ACP agent, for tests that need the host to have a live agent
 * session without a vendor process, an API key or a model.
 *
 * --mode (or ZUYCHIN_FAKE_AGENT_MODE when run directly) picks the behaviour:
 *
 *   hang       (default) accept the prompt and never answer, which is what "the
 *              host died mid-turn" means from the ledger's point of view
 *   speak      emit one message chunk and end the turn
 *   crash      exit as soon as the prompt arrives, for adapter-death handling
 *   hang-first hang if this is the first process recorded in --trace, else speak
 *   chatter    stream a chunk every 250ms and never end the turn
 *   terminal   run a host terminal for --terminal-ms, then end the turn
 *   fail       answer every prompt with an error
 *
 * --trace appends one JSON line per start, prompt and cancel. --liveness
 * connects a loopback socket that closes when this process dies, because a
 * recorded pid can be recycled. Arguments rather than environment: the host
 * filters ZUYCHIN_* out of every adapter's environment.
 *
 * Plain .mjs on purpose: the host spawns an agent with cwd set to its worktree,
 * a sibling directory with no node_modules, so anything needing a TypeScript
 * loader resolved from cwd would not start. Bare specifiers resolve from THIS
 * file's directory, so the SDK is still found.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

function option(name) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const trace = option("trace");
const record = (value) => { if (trace) appendFileSync(trace, `${JSON.stringify({ pid: process.pid, ...value })}\n`); };
const earlierStarts = trace && existsSync(trace)
    ? readFileSync(trace, "utf8").split("\n").filter(Boolean).filter((line) => JSON.parse(line).event === "start").length
    : 0;
const requested = option("mode") ?? process.env.ZUYCHIN_FAKE_AGENT_MODE ?? "hang";
const mode = requested === "hang-first" ? (earlierStarts === 0 ? "hang" : "speak") : requested;
const terminalMs = Number(option("terminal-ms") ?? 3_000);

const livenessPort = option("liveness");
if (livenessPort) {
    const liveness = connect(Number(livenessPort), "127.0.0.1");
    await once(liveness, "connect");
    liveness.on("error", () => {});
    liveness.write(String(process.pid));
    liveness.unref();
}
record({ event: "start", mode });

const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
);

acp.agent({ name: "zuychin-fake-agent" })
    .onRequest("initialize", () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
    }))
    .onRequest("session/new", () => ({ sessionId: randomUUID() }))
    .onRequest("session/prompt", async (ctx) => {
        const { sessionId } = ctx.params;
        record({ event: "prompt", prompt: ctx.params.prompt.map((block) => block.text ?? "").join("") });
        if (mode === "crash") process.exit(7);
        if (mode === "hang") return new Promise(() => {});
        if (mode === "fail") throw new acp.RequestError(-32603, "fake agent failure");
        const chunk = (text) => ctx.client.notify("session/update", {
            sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
        if (mode === "chatter") {
            setInterval(() => void chunk("still working").catch(() => {}), 250);
            return new Promise(() => {});
        }
        if (mode === "terminal") {
            const { terminalId } = await ctx.client.request("terminal/create", {
                sessionId, command: process.execPath, args: ["-e", `setTimeout(() => {}, ${terminalMs})`],
            });
            await ctx.client.request("terminal/wait_for_exit", { sessionId, terminalId });
            await ctx.client.request("terminal/release", { sessionId, terminalId });
        }
        await chunk("fake agent acknowledging the turn");
        record({ event: "end" });
        return { stopReason: "end_turn" };
    })
    .onNotification("session/cancel", () => { record({ event: "cancel" }); })
    .connect(stream);
