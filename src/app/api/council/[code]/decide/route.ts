import { NextRequest, NextResponse } from "next/server";
import { finalizeCouncil } from "@/lib/council/close";
import { continueTheCouncil } from "@/lib/council/owner-channel";
import { getSessionByCode } from "@/lib/council/store";

// Duy's ruling on a proposed verdict. Session-gated by proxy.ts. Accept is the
// step that produces everything durable; Continue reopens the debate with a
// fresh assignment, because reopening without one reproduces the stall that
// ended the round.

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const body = await req.json().catch(() => ({}));
        const decision = body.decision === "continue" ? "continue" : "accept";
        const directive = typeof body.directive === "string" ? body.directive.trim() : "";

        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404 });
        if (session.status !== "awaiting_owner") {
            return NextResponse.json(
                { error: `That council is ${session.status}, not waiting on you.` },
                { status: 409 },
            );
        }

        if (decision === "accept") {
            const outcome = await finalizeCouncil(session);
            return NextResponse.json({
                decision: "accept",
                changed: outcome.changed,
                vaultPath: outcome.vaultPath,
                campaignId: outcome.campaignId,
                archiveError: outcome.archiveError,
            });
        }

        const outcome = await continueTheCouncil({ session, directive });
        if (!outcome.ok) {
            return NextResponse.json({ error: outcome.reason ?? "Could not reopen it." }, { status: 409 });
        }
        return NextResponse.json({ decision: "continue", ...outcome });
    } catch (error) {
        console.error("[Council API] decide failed:", error);
        return NextResponse.json({ error: "Failed to record that decision." }, { status: 500 });
    }
}
