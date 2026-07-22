import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import {
    verifySlackSignature,
    isOwnMessage,
    type SlackMessageEvent,
} from "@/lib/messaging/slack-service";
import {
    isTrackedThread,
    handleThreadReply,
    startCoworkingThread,
} from "@/lib/messaging/slack-orchestrator";

export const maxDuration = 300;

// Best-effort in-process dedupe. Slack redelivers an event when the ack is slow;
// we ack immediately so retries are rare. Phase 4 promotes this to a persisted
// ledger if cross-instance dedupe becomes necessary.
const seenEvents = new Set<string>();
function alreadySeen(eventId: string | undefined): boolean {
    if (!eventId) return false;
    if (seenEvents.has(eventId)) return true;
    seenEvents.add(eventId);
    if (seenEvents.size > 2000) seenEvents.delete(seenEvents.values().next().value as string);
    return false;
}

export async function POST(req: NextRequest) {
    const rawBody = await req.text();
    const signature = req.headers.get("x-slack-signature");
    const timestamp = req.headers.get("x-slack-request-timestamp");

    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return NextResponse.json({ ok: true });
    }

    // Endpoint registration handshake.
    if (payload.type === "url_verification") {
        return NextResponse.json({ challenge: payload.challenge });
    }

    if (!verifySlackSignature(rawBody, signature, timestamp)) {
        return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }

    // Ack within Slack's 3s window; do the work after responding.
    if (payload.type === "event_callback") {
        const eventId = payload.event_id as string | undefined;
        if (!alreadySeen(eventId)) {
            const event = payload.event as SlackMessageEvent;
            after(() => handleEvent(event).catch((e) => console.error("[Slack] handleEvent failed:", e)));
        }
    }

    return NextResponse.json({ ok: true });
}

// Leading <@U…> mention tokens Slack prepends to app_mention text.
function stripLeadingMentions(text: string): string {
    return text.replace(/^(\s*<@[^>]+>\s*)+/, "").trim();
}

async function handleEvent(event: SlackMessageEvent) {
    if (!event) return;
    if (isOwnMessage(event)) return; // never react to our own posts

    // A reply inside a tracked co-working thread drives the next turn.
    if (event.thread_ts && (await isTrackedThread(event.thread_ts))) {
        await handleThreadReply(event);
        return;
    }

    // A fresh mention of Zuychin starts a co-working thread rooted at that message.
    if (event.type === "app_mention" && event.channel && event.ts) {
        const task = stripLeadingMentions(event.text ?? "");
        await startCoworkingThread(event.channel, task, event.ts);
    }
}
