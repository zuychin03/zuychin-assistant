import { NextRequest, NextResponse } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { sanitizeGenParams } from "@/lib/ai/providers";
import { getArtifact } from "@/lib/artifacts/store";
import { isSupportedAttachment, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from "@/lib/types";
import type { FileAttachment } from "@/lib/types";
import type { MessageChannel } from "@/lib/types";

const VALID_CHANNELS: MessageChannel[] = ["web", "discord", "telegram"];

export const maxDuration = 300;

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
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

        const { reply, messageId, artifacts } = await ragChat({
            message: message.trim(),
            channel,
            imageBase64,
            file: validatedFile,
            conversationId,
            thinking,
            search,
            agent,
            provider,
            model,
            embeddingModel,
            genParams: sanitizeGenParams(genParams),
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

        return NextResponse.json({ reply, messageId, artifacts: artifactsWithData });
    } catch (error: unknown) {
        console.error("[Chat API Error]", error);

        const errorMessage =
            error instanceof Error ? error.message : "An unexpected error occurred.";

        return NextResponse.json(
            { error: errorMessage },
            { status: 500 }
        );
    }
}
