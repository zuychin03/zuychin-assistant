import { NextRequest, NextResponse } from "next/server";
import { finalizeCouncil } from "@/lib/council/close";
import { continueTheCouncil } from "@/lib/council/owner-channel";
import { getSessionByCode } from "@/lib/council/store";
import { isOnlineCouncil } from "@/lib/council/online/store";
import { ensureOnlineRunner } from "@/lib/council/online/service";

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
                archiveError: outcome.archiveError,
            });
        }

        const outcome = await continueTheCouncil({ session, directive });
        if (!outcome.ok) {
            return NextResponse.json({ error: outcome.reason ?? "Could not reopen it." }, { status: 409 });
        }
        // The runner stopped when the verdict was proposed; the reopened rounds need it back.
        if (session.protocolVersion === 3 && session.councilType === "debate" && await isOnlineCouncil(session.id).catch(() => false)) {
            ensureOnlineRunner(session.id);
        }
        return NextResponse.json({ decision: "continue", ...outcome });
    } catch (error) {
        console.error("[Council API] decide failed:", error);
        return NextResponse.json({ error: "Failed to record that decision." }, { status: 500 });
    }
}
