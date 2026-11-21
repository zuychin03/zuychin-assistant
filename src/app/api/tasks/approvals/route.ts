import { NextRequest, NextResponse } from "next/server";
import { claimApproval, completeApproval } from "@/lib/tasks/decide";
import { taskFailure, requireApprovalOwner, TaskInputError } from "@/lib/tasks/http";

export const maxDuration = 300;
export async function POST(req: NextRequest) {
    const denied = await requireApprovalOwner(req); if (denied) return denied;
    try {
        const body = await req.json();
        if (!body || typeof body !== "object" || Object.keys(body).some((key) => !["id","decision"].includes(key)) || !["approve","reject"].includes(body.decision)) throw new TaskInputError("Provide an approval ID and approve or reject decision.");
        const claim = await claimApproval(body.id, body.decision);
        if (claim.kind === "missing") return NextResponse.json({ error: "Approval not found." }, { status: 404 });
        if (claim.kind === "taken") return NextResponse.json({ approval: claim.approval, error: "This action is already decided, expired or executing." }, { status: 409 });
        const { approval, stored } = await completeApproval(claim, "web");
        if (body.decision === "reject") return NextResponse.json({ approval });
        return NextResponse.json({ approval,
            ...(!stored ? { warning: "The action may have run, but its receipt could not be saved. Do not repeat it." } : {}) });
    } catch (error) { return taskFailure(error); }
}
