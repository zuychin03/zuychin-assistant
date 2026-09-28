import { NextRequest } from "next/server";
import { requireChatAuth } from "@/lib/auth/guard";
import { supabaseAdmin } from "@/lib/supabase";
import { BranchError, validConversationId } from "@/lib/conversations/branches";
import { createBranchStore } from "@/lib/conversations/branch-store";
import { branchFailure, branchResponse, branchUserId } from "@/lib/conversations/branch-api";

export async function GET(req: NextRequest) {
    const denied = await requireChatAuth(req);
    if (denied) return denied;
    try {
        const left = req.nextUrl.searchParams.get("left"), right = req.nextUrl.searchParams.get("right");
        if (!validConversationId(left) || !validConversationId(right) || left === right) throw new BranchError("Choose two different related conversations.", 400);
        return branchResponse(await createBranchStore(supabaseAdmin).compare(left, right, await branchUserId(), req.signal));
    } catch (error) { return branchFailure(error); }
}
