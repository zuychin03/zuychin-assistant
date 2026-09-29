import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode } from "@/lib/council/store";
import { issueSeatKey, listSeatKeys, revokeSeatKey } from "@/lib/council/seat-keys";
import { getCampaignForSession } from "@/lib/council/campaign";

// Owner session auth is enforced by proxy.ts; reissue replaces the existing hash.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404 });
        return NextResponse.json({ keys: await listSeatKeys(session.id) });
    } catch (error) {
        console.error("[Council API] seat key list failed:", error);
        return NextResponse.json({ error: "Failed to load seat keys." }, { status: 500 });
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const body = await req.json().catch(() => ({}));
        const seatName = typeof body.seatName === "string" ? body.seatName.trim() : "";
        if (!seatName) return NextResponse.json({ error: "Name the seat first." }, { status: 400 });

        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404 });
        if (session.pausedAt || !["open", "concluding", "closed"].includes(session.status)) {
            return NextResponse.json({ error: "That council is not active for seat issuance." }, { status: 409 });
        }

        if (session.status === "closed") {
            const campaign = await getCampaignForSession(session.id);
            const unfinished = campaign && (
                campaign.status === "running" || campaign.status === "blocked"
                || (campaign.status === "complete" && (
                    campaign.integrationStatus === null || campaign.integrationStatus === "pending"
                    || campaign.integrationStatus === "running"
                ))
            );
            if (!unfinished) {
                return NextResponse.json({ error: "That council has no unfinished campaign." }, { status: 409 });
            }
        }

        const issued = await issueSeatKey({ sessionId: session.id, seatName });
        if (!issued.ok) {
            const message = issued.reason === "not_on_roster"
                ? `"${seatName}" is not on this council's roster. Convene with that name first.`
                : issued.reason === "not_an_agent_seat"
                    ? `"${seatName}" is not an agent seat.`
                    : issued.reason === "inactive_session"
                        ? "That council is no longer active for seat issuance."
                        : "Could not issue a key for that seat.";
            return NextResponse.json({ error: message }, { status: 409 });
        }
        return NextResponse.json({ seatName, token: issued.token, expiresAt: issued.expiresAt });
    } catch (error) {
        console.error("[Council API] seat key issue failed:", error);
        return NextResponse.json({ error: "Failed to issue a seat key." }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const seatName = req.nextUrl.searchParams.get("seatName") ?? "";
        if (!seatName) return NextResponse.json({ error: "Name the seat first." }, { status: 400 });
        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404 });
        await revokeSeatKey(session.id, seatName);
        return NextResponse.json({ revoked: seatName });
    } catch (error) {
        console.error("[Council API] seat key revoke failed:", error);
        return NextResponse.json({ error: "Failed to revoke that key." }, { status: 500 });
    }
}
