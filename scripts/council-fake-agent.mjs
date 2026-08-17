/**
 * A stand-in ACP agent, for tests that need the host to have a live agent
 * session without a vendor process, an API key or a model.
 *
 * ZUYCHIN_FAKE_AGENT_MODE picks the behaviour:
 *
 *   hang   (default) accept the prompt and never answer, which is what "the
 *          host died mid-turn" means from the ledger's point of view
 *   speak  emit one message chunk and end the turn
 *   crash  exit as soon as the prompt arrives, for adapter-death handling
 *
 * Plain .mjs on purpose: the host spawns an agent with cwd set to its worktree,
 * a sibling directory with no node_modules, so anything needing a TypeScript
 * loader resolved from cwd would not start. Bare specifiers resolve from THIS
 * file's directory, so the SDK is still found.
 */
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.env.ZUYCHIN_FAKE_AGENT_MODE ?? "hang";

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
        if (mode === "crash") process.exit(7);
        if (mode === "hang") return new Promise(() => {});
        await ctx.client.notify("session/update", {
            sessionId: ctx.params.sessionId,
            update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "fake agent acknowledging the turn" },
            },
        });
        return { stopReason: "end_turn" };
    })
    .onNotification("session/cancel", () => {})
    .connect(stream);
