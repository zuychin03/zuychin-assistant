import { NextRequest } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { supabaseAdmin } from "@/lib/supabase";
import { BranchError, parseForkRequest, validConversationId } from "@/lib/conversations/branches";
import { createBranchStore } from "@/lib/conversations/branch-store";
import { branchFailure, branchResponse, branchUserId } from "@/lib/conversations/branch-api";

export async function POST(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    try {
        let body: unknown;
        try { body = await req.json(); } catch { throw new BranchError("Provide a JSON branch request.", 400); }
        const input = parseForkRequest(body);
        const userId = await branchUserId();
        const conversation = await createBranchStore(supabaseAdmin).fork(input, userId, req.signal);
        return branchResponse({ conversation }, 201);
    } catch (error) { return branchFailure(error); }
}
export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    try {
        const id = req.nextUrl.searchParams.get("conversationId");
        if (!validConversationId(id)) throw new BranchError("A valid conversationId is required.", 400);
        return branchResponse(await createBranchStore(supabaseAdmin).list(id, await branchUserId(), req.signal));
    } catch (error) { return branchFailure(error); }
}
