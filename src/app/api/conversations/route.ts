import { NextRequest, NextResponse } from "next/server";
import { listConversations, createConversation, deleteConversation, getConversationMessages } from "@/lib/db";

/**
 * GET /api/conversations — List all conversations
 * GET /api/conversations?id=xxx — Get messages for a conversation
 */
export async function GET(req: NextRequest) {
    try {
        const conversationId = req.nextUrl.searchParams.get("id");

        if (conversationId) {
            // Get messages for a specific conversation
            const messages = await getConversationMessages(conversationId);
            return NextResponse.json({ messages });
        }

        // List all conversations
        const conversations = await listConversations(50);
        return NextResponse.json({ conversations });
    } catch (error: unknown) {
        console.error("[Conversations API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

/**
 * POST /api/conversations — Create a new conversation
 */
export async function POST() {
    try {
        const conversation = await createConversation({});
        return NextResponse.json(conversation);
    } catch (error: unknown) {
        console.error("[Conversations API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

/**
 * DELETE /api/conversations?id=xxx — Delete a conversation
 */
export async function DELETE(req: NextRequest) {
    try {
        const id = req.nextUrl.searchParams.get("id");

        if (!id) {
            return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
        }

        await deleteConversation(id);
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        console.error("[Conversations API Error]", error);
        const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
