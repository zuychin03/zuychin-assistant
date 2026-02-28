import { NextRequest, NextResponse } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { ALL_SUPPORTED_MIME_TYPES, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from "@/lib/types";
import type { FileAttachment } from "@/lib/types";
import type { MessageChannel } from "@/lib/types";

const VALID_CHANNELS: MessageChannel[] = ["web", "discord"];

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { message, channel = "web", imageBase64, conversationId, file, thinking = false } = body;

        // Validate input
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

        // Validate file
        let validatedFile: FileAttachment | undefined;
        if (file) {
            if (!ALL_SUPPORTED_MIME_TYPES.includes(file.mimeType)) {
                return NextResponse.json(
                    { error: `Unsupported file type: ${file.mimeType}` },
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

        // Run RAG pipeline
        const { reply, messageId } = await ragChat({
            message: message.trim(),
            channel,
            imageBase64,
            file: validatedFile,
            conversationId,
            thinking,
        });

        return NextResponse.json({ reply, messageId });
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
