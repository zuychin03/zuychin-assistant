import { NextRequest, NextResponse } from "next/server";
import {
    verifySignature,
    parseMetaWebhook,
    sendMessengerReply,
    sendWhatsAppReply,
} from "@/lib/messaging/meta-service";
import { ragChat } from "@/lib/ai/rag-service";

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN!;

/** GET — Webhook verification handshake */

export async function GET(req: NextRequest) {
    const searchParams = req.nextUrl.searchParams;

    const mode = searchParams.get("hub.mode");
    const token = searchParams.get("hub.verify_token");
    const challenge = searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("[Webhook] Verified successfully.");
        return new NextResponse(challenge, { status: 200 });
    }

    console.warn("[Webhook] Verification failed. Token mismatch.");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/** POST — Handle incoming messages */

export async function POST(req: NextRequest) {
    try {
        // Read raw body for sig verification
        const rawBody = await req.text();
        const signature = req.headers.get("x-hub-signature-256");

        // Verify signature (skip in dev)
        if (process.env.NODE_ENV === "production") {
            if (!verifySignature(rawBody, signature)) {
                console.warn("[Webhook] Invalid signature.");
                return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
            }
        }

        // Parse payload
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        const messages = parseMetaWebhook(body);

        if (messages.length === 0) {
            // No actionable messages
            return NextResponse.json({ status: "ok" });
        }

        // Process & reply
        for (const msg of messages) {
            const userText = msg.text ?? "[Image received]";

            console.log(
                `[Webhook] ${msg.channel} message from ${msg.senderId}: ${userText.substring(0, 50)}`
            );

            // RAG pipeline
            const { reply } = await ragChat({
                message: userText,
                channel: msg.channel,
            });

            // Route reply to correct channel
            if (msg.channel === "whatsapp") {
                // WhatsApp needs phone_number_id from the payload
                const entry = (body.entry as Array<Record<string, unknown>>)?.[0];
                const changes = (entry?.changes as Array<Record<string, unknown>>)?.[0];
                const value = changes?.value as Record<string, unknown> | undefined;
                const metadata = value?.metadata as Record<string, string> | undefined;
                const phoneNumberId = metadata?.phone_number_id ?? "";

                await sendWhatsAppReply(phoneNumberId, msg.senderId, reply);
            } else {
                // Messenger / Instagram
                await sendMessengerReply(msg.senderId, reply);
            }
        }

        return NextResponse.json({ status: "ok" });
    } catch (error) {
        console.error("[Webhook] Error:", error);
        // Always 200 to Meta to prevent retries
        return NextResponse.json({ status: "error" }, { status: 200 });
    }
}
