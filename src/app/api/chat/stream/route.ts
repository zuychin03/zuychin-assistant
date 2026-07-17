import { NextRequest } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { sanitizeGenParams } from "@/lib/ai/providers";
import { isSupportedAttachment, MAX_FILE_SIZE_BYTES } from "@/lib/types";
import type { FileAttachment, MessageChannel, ReplyRef } from "@/lib/types";
import { sseFormat, type AgentEvent } from "@/lib/ai/agent/events";
import { broadcastPush } from "@/lib/messaging/push-service";

export const maxDuration = 300;

const SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
};

export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return oneShot({ type: "error", message: "Invalid request body." }, 400);
    }

    const message = body.message;
    if (!message || typeof message !== "string") {
        return oneShot({ type: "error", message: "Message is required." }, 400);
    }
    if (message.length > 10000) {
        return oneShot({ type: "error", message: "Message is too long (max 10,000 characters)." }, 400);
    }

    const channel = (body.channel as MessageChannel) ?? "web";
    const replyTo = parseReplyTo(body.replyTo);
    const file = body.file as FileAttachment | undefined;
    if (file) {
        if (!isSupportedAttachment(file.mimeType, file.name)) {
            return oneShot({ type: "error", message: `Unsupported file type: ${file.mimeType || file.name}` }, 400);
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
            return oneShot({ type: "error", message: "File too large." }, 400);
        }
    }

    const encoder = new TextEncoder();
    // Aborts when the client disconnects (stop button); ragChat propagates it
    // to the model calls and drops the turn server-side.
    const ac = new AbortController();
    const onClientAbort = () => ac.abort();
    req.signal.addEventListener("abort", onClientAbort);

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            let closed = false;
            // Agent-mode turns emit a run event; those are the long ones worth
            // a push when the user has tabbed away (sw.js skips focused tabs).
            let sawAgentRun = false;
            const send = (e: AgentEvent) => {
                if (e.type === "run") sawAgentRun = true;
                if (closed) return;
                try { controller.enqueue(encoder.encode(sseFormat(e))); } catch { }
            };
            const heartbeat = setInterval(() => {
                if (closed) return;
                try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { }
            }, 15000);

            try {
                const { reply, messageId, artifacts } = await ragChat({
                    message: message.trim(),
                    channel,
                    imageBase64: body.imageBase64 as string | undefined,
                    file,
                    conversationId: body.conversationId as string | undefined,
                    thinking: !!body.thinking,
                    search: !!body.search,
                    agent: !!body.agent,
                    resumeRunId: body.resumeRunId as string | undefined,
                    replyTo,
                    provider: body.provider as string | undefined,
                    model: body.model as string | undefined,
                    embeddingModel: body.embeddingModel as string | undefined,
                    genParams: sanitizeGenParams(body.genParams),
                    signal: ac.signal,
                }, send);
                send({ type: "done", reply, messageId, artifacts });
                if (sawAgentRun && reply) {
                    const convId = body.conversationId as string | undefined;
                    await broadcastPush({
                        title: "Zuychin finished your task",
                        body: reply.slice(0, 180),
                        url: convId ? `/?c=${convId}` : "/",
                    });
                }
            } catch (err) {
                if (!ac.signal.aborted) {
                    console.error("[Chat Stream Error]", err);
                    send({ type: "error", message: err instanceof Error ? err.message : "The agent failed." });
                }
            } finally {
                closed = true;
                clearInterval(heartbeat);
                req.signal.removeEventListener("abort", onClientAbort);
                try { controller.close(); } catch { }
            }
        },
        cancel() {
            ac.abort();
        },
    });

    return new Response(stream, { headers: SSE_HEADERS });
}

function parseReplyTo(raw: unknown): ReplyRef | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const { role, content } = raw as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) {
        return undefined;
    }
    return { role, content: content.slice(0, 2000) };
}

function oneShot(event: AgentEvent, status: number): Response {
    return new Response(sseFormat(event), { status, headers: SSE_HEADERS });
}
