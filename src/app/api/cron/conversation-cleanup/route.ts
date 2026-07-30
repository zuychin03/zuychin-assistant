import { after, NextRequest, NextResponse } from "next/server";
import { reviewConversationCleanup } from "@/lib/conversation-cleanup";
import { requireCron } from "@/lib/auth/guard";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
    const denied = requireCron(req);
    if (denied) return denied;

    after(async () => {
        try {
            const result = await reviewConversationCleanup();
            console.log(`[ConversationCleanup] reviewed=${result.reviewed} recommendations=${result.recommendations} skipped=${result.skipped}`);
        } catch (error) {
            console.error("[ConversationCleanup] Review failed:", error);
        }
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
}
