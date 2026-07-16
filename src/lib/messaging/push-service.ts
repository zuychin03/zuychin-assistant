import webpush from "web-push";
import { supabaseAdmin as supabase } from "@/lib/supabase";

// Node-runtime only (web-push uses node crypto/http); never import from an
// edge route. Payloads must stay under the 4 KB push-service cap.

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:k.duy1202@gmail.com";

let configured = false;
function ensureConfigured(): boolean {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
    if (!configured) {
        webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
        configured = true;
    }
    return true;
}

export interface PushPayload {
    title: string;
    body: string;
    url?: string;
}

/**
 * Send a notification to every stored subscription. Expired endpoints
 * (404/410) are pruned as they surface. Best-effort: returns the delivered
 * count, never throws.
 */
export async function broadcastPush(payload: PushPayload): Promise<number> {
    if (!ensureConfigured()) return 0;

    const { data, error } = await supabase
        .from("push_subscriptions")
        .select("id, endpoint, keys");
    if (error || !data || data.length === 0) {
        if (error) console.warn("[Push] Failed to read subscriptions:", error.message);
        return 0;
    }

    const body = JSON.stringify({
        title: payload.title.slice(0, 100),
        body: payload.body.slice(0, 1000),
        url: payload.url ?? "/",
    });

    let delivered = 0;
    await Promise.all(data.map(async (sub) => {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
                body
            );
            delivered++;
        } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
                await supabase.from("push_subscriptions").delete().eq("id", sub.id);
                console.log(`[Push] Pruned expired subscription ${sub.id}`);
            } else {
                console.warn("[Push] Send failed:", status ?? err);
            }
        }
    }));
    return delivered;
}
