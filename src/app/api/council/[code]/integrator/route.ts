import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode } from "@/lib/council/store";
import { setCampaignIntegrator } from "@/lib/council/campaign";

// Nominates one agent to assemble every accepted task on a clean integration
// branch. Session-gated by proxy.ts. Delegating the assembly is Duy's approval
// of that agent doing the work, NOT of the result shipping: the integrator's
// allowed refs exclude the base branch, and the merge decision stays his.

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const body = await req.json().catch(() => ({}));
        const agentName = typeof body.agentName === "string" ? body.agentName.trim() : "";
        if (!agentName) return NextResponse.json({ error: "Name an agent first." }, { status: 400 });

        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404 });

        const res = await setCampaignIntegrator({ sessionId: session.id, agentName });
        if (!res.ok) {
            const message = res.reason === "campaign_incomplete"
                ? `Every task has to be accepted first; the campaign is ${res.status}.`
                : res.reason === "not_on_roster"
                    ? `"${agentName}" is not on this council's roster.`
                    : res.reason === "no_campaign"
                        ? "That council has no work campaign."
                        : "Could not nominate an integrator.";
            return NextResponse.json({ error: message }, { status: 409 });
        }
        return NextResponse.json({ integratorAgent: agentName });
    } catch (error) {
        console.error("[Council API] integrator failed:", error);
        return NextResponse.json({ error: "Failed to nominate an integrator." }, { status: 500 });
    }
}
