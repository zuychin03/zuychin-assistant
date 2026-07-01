import { NextRequest } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { sanitizeGenParams } from "@/lib/ai/providers";
import { isSupportedAttachment, MAX_FILE_SIZE_BYTES } from "@/lib/types";
import type { FileAttachment, MessageChannel } from "@/lib/types";
import { sseFormat, type AgentEvent } from "@/lib/ai/agent/events";

// Agent runs make many model calls; give the function room (Vercel Pro = 300s).
export const maxDuration = 300;

const SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering so events flush immediately.
    "X-Accel-Buffering": "no",
};

// POST /api/chat/stream — same as /api/chat but streams agent progress over SSE.
// Used by the web UI; Discord/Telegram/cron keep using the JSON /api/chat.
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
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            let closed = false;
            const send = (e: AgentEvent) => {
                if (closed) return;
                try { controller.enqueue(encoder.encode(sseFormat(e))); } catch { /* client gone */ }
            };
            // Keep-alive comments so intermediaries don't drop an idle connection.
            const heartbeat = setInterval(() => {
                if (closed) return;
                try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* ignore */ }
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
                    provider: body.provider as string | undefined,
                    model: body.model as string | undefined,
                    embeddingModel: body.embeddingModel as string | undefined,
                    genParams: sanitizeGenParams(body.genParams),
                }, send);
                send({ type: "done", reply, messageId, artifacts });
            } catch (err) {
                console.error("[Chat Stream Error]", err);
                send({ type: "error", message: err instanceof Error ? err.message : "The agent failed." });
            } finally {
                closed = true;
                clearInterval(heartbeat);
                try { controller.close(); } catch { /* already closed */ }
            }
        },
    });

    return new Response(stream, { headers: SSE_HEADERS });
}

// Emit a single SSE event (used for early validation errors) so the client parses
// everything the same way.
function oneShot(event: AgentEvent, status: number): Response {
    return new Response(sseFormat(event), { status, headers: SSE_HEADERS });
}
