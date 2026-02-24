import crypto from "crypto";



const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN!;
const APP_SECRET = process.env.META_APP_SECRET!;

// --- Signature Verification ---


/** Verify HMAC SHA-256 signature from Meta. */
export function verifySignature(
    rawBody: string,
    signature: string | null
): boolean {
    if (!signature || !APP_SECRET) return false;

    const expectedSignature =
        "sha256=" +
        crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}

// --- Message Parsing ---


export interface MetaIncomingMessage {
    senderId: string;
    text?: string;
    imageUrl?: string;
    channel: "messenger" | "instagram" | "whatsapp";
    timestamp: number;
}

/** Parse Meta webhook payload into normalized messages (Messenger/IG/WhatsApp). */
export function parseMetaWebhook(body: Record<string, unknown>): MetaIncomingMessage[] {
    const messages: MetaIncomingMessage[] = [];
    const obj = body.object as string | undefined;

    // Messenger / Instagram (Page webhook)
    if (obj === "page" || obj === "instagram") {
        const channel = obj === "instagram" ? "instagram" : "messenger";
        const entries = (body.entry as Array<Record<string, unknown>>) ?? [];

        for (const entry of entries) {
            const messagingEvents = (entry.messaging as Array<Record<string, unknown>>) ?? [];

            for (const event of messagingEvents) {
                const sender = event.sender as Record<string, string> | undefined;
                const message = event.message as Record<string, unknown> | undefined;

                if (!sender?.id || !message) continue;

                const parsed: MetaIncomingMessage = {
                    senderId: sender.id,
                    channel,
                    timestamp: (event.timestamp as number) ?? Date.now(),
                };

                // Text message
                if (typeof message.text === "string") {
                    parsed.text = message.text;
                }

                // Image attachment
                const attachments = message.attachments as Array<Record<string, unknown>> | undefined;
                if (attachments?.length) {
                    const imageAttachment = attachments.find((a) => a.type === "image");
                    if (imageAttachment) {
                        const payload = imageAttachment.payload as Record<string, string> | undefined;
                        parsed.imageUrl = payload?.url;
                    }
                }

                if (parsed.text || parsed.imageUrl) {
                    messages.push(parsed);
                }
            }
        }
    }

    // WhatsApp (Cloud API)
    if (obj === "whatsapp_business_account") {
        const entries = (body.entry as Array<Record<string, unknown>>) ?? [];

        for (const entry of entries) {
            const changes = (entry.changes as Array<Record<string, unknown>>) ?? [];

            for (const change of changes) {
                const value = change.value as Record<string, unknown> | undefined;
                if (!value) continue;

                const waMessages = (value.messages as Array<Record<string, unknown>>) ?? [];

                for (const msg of waMessages) {
                    const parsed: MetaIncomingMessage = {
                        senderId: msg.from as string,
                        channel: "whatsapp",
                        timestamp: parseInt(msg.timestamp as string, 10) * 1000 || Date.now(),
                    };

                    if (msg.type === "text") {
                        const textObj = msg.text as Record<string, string> | undefined;
                        parsed.text = textObj?.body;
                    }

                    if (msg.type === "image") {
                        const imageObj = msg.image as Record<string, string> | undefined;
                        parsed.imageUrl = imageObj?.id; // Will need separate download via Graph API
                    }

                    if (parsed.text || parsed.imageUrl) {
                        messages.push(parsed);
                    }
                }
            }
        }
    }

    return messages;
}

// --- Send Reply ---


/** Send a text reply via Messenger/Instagram. */
export async function sendMessengerReply(
    recipientId: string,
    text: string
): Promise<boolean> {
    try {
        const res = await fetch(
            `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    recipient: { id: recipientId },
                    message: { text },
                }),
            }
        );

        if (!res.ok) {
            const err = await res.json();
            console.error("[Meta] Send failed:", err);
            return false;
        }

        return true;
    } catch (error) {
        console.error("[Meta] Send error:", error);
        return false;
    }
}

/** Send a text reply via WhatsApp Cloud API. */
export async function sendWhatsAppReply(
    phoneNumberId: string,
    recipientPhone: string,
    text: string
): Promise<boolean> {
    try {
        const res = await fetch(
            `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`,
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: recipientPhone,
                    type: "text",
                    text: { body: text },
                }),
            }
        );

        if (!res.ok) {
            const err = await res.json();
            console.error("[WhatsApp] Send failed:", err);
            return false;
        }

        return true;
    } catch (error) {
        console.error("[WhatsApp] Send error:", error);
        return false;
    }
}
