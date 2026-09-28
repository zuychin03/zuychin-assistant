import { NextRequest, NextResponse } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { knowledgeOnlyRequestError } from "@/lib/knowledge/chat";
import { requireChatAuth } from "@/lib/auth/guard";
import { sanitizeGenParams } from "@/lib/ai/providers";
import { getArtifact } from "@/lib/artifacts/store";
import { isSupportedAttachment, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from "@/lib/types";
import type { FileAttachment } from "@/lib/types";
import type { MessageChannel } from "@/lib/types";
import { resumeRequestError, ResumeScopeError } from "@/lib/ai/agent/resume-scope";

const VALID_CHANNELS: MessageChannel[] = ["web", "discord", "telegram"];

export const maxDuration = 300;

export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    try {
        const body = await req.json();
        if (body.freeOnly !== undefined && typeof body.freeOnly !== "boolean") return NextResponse.json({ error: "Free only must be a boolean." }, { status: 400 });
        const knowledgeError = knowledgeOnlyRequestError(body);
        if (knowledgeError) return NextResponse.json({ error: knowledgeError }, { status: 400 });
        const resumeError = resumeRequestError(body);
        if (resumeError) return NextResponse.json({ error: resumeError }, { status: 400 });
        const { message, channel = "web", imageBase64, conversationId, file, thinking = false, search = false, agent = false, provider, model, embeddingModel, genParams } = body;

        if (!message || typeof message !== "string") {
            return NextResponse.json(
                { error: "Message is required." },
                { status: 400 }
            );
        }

        if (message.length > 10000) {
            return NextResponse.json(
                { error: "Message is too long (max 10,000 characters)." },
                { status: 400 }
            );
        }

        if (!VALID_CHANNELS.includes(channel)) {
            return NextResponse.json(
                { error: `Invalid channel. Must be one of: ${VALID_CHANNELS.join(", ")}` },
                { status: 400 }
            );
        }

        let validatedFile: FileAttachment | undefined;
        if (file) {
            if (!isSupportedAttachment(file.mimeType, file.name)) {
                return NextResponse.json(
                    { error: `Unsupported file type: ${file.mimeType || file.name}` },
                    { status: 400 }
                );
            }
            if (file.size > MAX_FILE_SIZE_BYTES) {
                return NextResponse.json(
                    { error: `File too large. Max ${MAX_FILE_SIZE_MB} MB.` },
                    { status: 400 }
                );
            }
            validatedFile = file;
        }

        const { reply, messageId, userMessageId, artifacts, replyTrace } = await ragChat({
            message: message.trim(),
            channel,
            imageBase64,
            file: validatedFile,
            conversationId,
            thinking,
            search,
            agent,
            resumeRunId: body.resumeRunId,
            freeOnly: body.freeOnly === true,
            knowledgeOnly: body.knowledgeOnly,
            provider,
            model,
            embeddingModel,
            genParams: sanitizeGenParams(genParams),
            signal: req.signal,
        });

        const artifactsWithData = await Promise.all(
            artifacts.map(async (a) => {
                const stored = await getArtifact(a.id);
                const base64 = !stored
                    ? undefined
                    : typeof stored.body === "string"
                        ? Buffer.from(stored.body, "utf-8").toString("base64")
                        : stored.body.toString("base64");
                return { ...a, base64 };
            })
        );

        return NextResponse.json({ reply, messageId, userMessageId, replyTrace, artifacts: artifactsWithData });
    } catch (error: unknown) {
        console.error("[Chat API Error]", error);

        const errorMessage =
            error instanceof Error ? error.message : "An unexpected error occurred.";

        return NextResponse.json(
            { error: errorMessage },
            { status: error instanceof ResumeScopeError ? 404 : 500 }
        );
    }
}
