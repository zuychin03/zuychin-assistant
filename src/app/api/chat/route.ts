import { NextRequest, NextResponse } from "next/server";
import { ragChat } from "@/lib/ai/rag-service";
import { knowledgeOnlyRequestError } from "@/lib/knowledge/chat";
import { requireChatAuth } from "@/lib/auth/guard";
import { sanitizeGenParams } from "@/lib/ai/providers";
import { getArtifact } from "@/lib/artifacts/store";
import { base64Bytes, isMessageChannel, isSupportedAttachment, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, MESSAGE_CHANNELS, parseReplyRef } from "@/lib/types";
import { bodyFailure, readJsonCapped } from "@/lib/http/body";
import type { FileAttachment } from "@/lib/types";
import { resumeRequestError, ResumeScopeError } from "@/lib/ai/agent/resume-scope";
import { inputModeError } from "@/lib/voice/input-mode";
import { discordSpeechAttachment } from "@/lib/voice/discord-speech";
import { botPlaceholder, discordVoice, isDiscordVoice } from "@/lib/voice/discord-voice";
import { photoAttachments } from "@/lib/knowledge/photo-files";
import { CHANNEL_STARTED_TEXT, channelHelpText, channelTurn } from "@/lib/messaging/channel-threads";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    try {
        const body = await readJsonCapped(req);
        if (body.freeOnly !== undefined && typeof body.freeOnly !== "boolean") return NextResponse.json({ error: "Free only must be a boolean." }, { status: 400 });
        const knowledgeError = knowledgeOnlyRequestError(body);
        if (knowledgeError) return NextResponse.json({ error: knowledgeError }, { status: 400 });
        const resumeError = resumeRequestError(body);
        if (resumeError) return NextResponse.json({ error: resumeError }, { status: 400 });
        const inputError = inputModeError(body.inputMode);
        if (inputError) return NextResponse.json({ error: inputError }, { status: 400 });
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

        if (!isMessageChannel(channel)) {
            return NextResponse.json(
                { error: `Invalid channel. Must be one of: ${MESSAGE_CHANNELS.join(", ")}` },
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
            if (file.size > MAX_FILE_SIZE_BYTES || base64Bytes(file.base64) > MAX_FILE_SIZE_BYTES) {
                return NextResponse.json(
                    { error: `File too large. Max ${MAX_FILE_SIZE_MB} MB.` },
                    { status: 400 }
                );
            }
            validatedFile = file;
        }
        if (base64Bytes(imageBase64) > MAX_FILE_SIZE_BYTES) {
            return NextResponse.json({ error: `Image too large. Max ${MAX_FILE_SIZE_MB} MB.` }, { status: 400 });
        }

        // The bot posts #ask-zuychin without a conversation id; the server keeps that chat's conversation.
        let text: string = message.trim();
        let turnConversationId = conversationId;
        let inputMode: "voice" | undefined = body.inputMode === "voice" ? "voice" : undefined;
        if (channel === "discord" && validatedFile && isDiscordVoice(validatedFile)) {
            const heard = await discordVoice(validatedFile, body.freeOnly === true, req.signal);
            if (heard.kind === "reply") return NextResponse.json({ reply: heard.reply, messageId: "", userMessageId: "", artifacts: heard.artifacts });
            if (heard.kind === "spoken") {
                text = [botPlaceholder(text, validatedFile) ? "" : text, heard.text].filter(Boolean).join("\n\n");
                validatedFile = undefined;
                inputMode = "voice";
            }
        }
        if (channel === "discord" && !conversationId) {
            const chatKey = typeof body.chatKey === "string" && /^[\w-]{1,128}$/.test(body.chatKey) ? body.chatKey : "ask-zuychin";
            const turn = await channelTurn("discord", chatKey, text);
            if (turn.kind !== "message") {
                const reply = turn.kind === "help" ? channelHelpText() : CHANNEL_STARTED_TEXT;
                return NextResponse.json({ reply, messageId: "", userMessageId: "", artifacts: [] });
            }
            text = turn.message;
            turnConversationId = turn.conversationId ?? undefined;
        }

        const { reply, messageId, userMessageId, artifacts, replyTrace, photos, speak } = await ragChat({
            message: text,
            channel,
            imageBase64,
            file: validatedFile,
            conversationId: turnConversationId,
            thinking,
            search,
            agent,
            resumeRunId: body.resumeRunId,
            freeOnly: body.freeOnly === true,
            inputMode,
            // The bot sends the message a /translate replies to (V8 F9).
            replyTo: parseReplyRef(body.replyTo),
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

        const speech = channel === "discord" ? await discordSpeechAttachment(reply, body.freeOnly === true, req.signal, inputMode === "voice", speak === true) : null;
        // The bot attaches every artifact with bytes, so cited photos arrive with the reply.
        const cited = channel === "discord" ? await photoAttachments(photos) : [];
        return NextResponse.json({ reply, messageId, userMessageId, replyTrace, artifacts: [...artifactsWithData, ...(speech ? [speech] : []), ...cited] });
    } catch (error: unknown) {
        const failed = bodyFailure(error);
        if (failed) return failed;
        console.error("[Chat API Error]", error);

        const errorMessage =
            error instanceof Error ? error.message : "An unexpected error occurred.";

        return NextResponse.json(
            { error: errorMessage },
            { status: error instanceof ResumeScopeError ? 404 : 500 }
        );
    }
}
