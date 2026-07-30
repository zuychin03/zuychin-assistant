import { NextRequest, NextResponse } from "next/server";
import {
    dismissConversationCleanupRecommendation,
    listConversationCleanupRecommendations,
    reviewConversationCleanup,
} from "@/lib/conversation-cleanup";

export const maxDuration = 300;

export async function GET() {
    try {
        return NextResponse.json({ recommendations: await listConversationCleanupRecommendations() });
    } catch (error) {
        console.error("[ConversationCleanup] Failed to load recommendations:", error);
        return NextResponse.json({ error: "Failed to load cleanup recommendations." }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        if (body.action === "dismiss" && typeof body.conversationId === "string") {
            await dismissConversationCleanupRecommendation(body.conversationId);
            return NextResponse.json({ success: true });
        }
        if (body.action === "review") {
            const result = await reviewConversationCleanup({ force: true });
            return NextResponse.json(result);
        }
        return NextResponse.json({ error: "Unknown cleanup action." }, { status: 400 });
    } catch (error) {
        console.error("[ConversationCleanup] Action failed:", error);
        return NextResponse.json({ error: "Conversation cleanup action failed." }, { status: 500 });
    }
}
