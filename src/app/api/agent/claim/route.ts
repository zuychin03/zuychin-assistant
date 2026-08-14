import { NextRequest, NextResponse } from "next/server";
import { beginClaimAttempt, exchangeClaim, finishClaimAttempt, hashClientIp } from "@/lib/agents/clients";

// The only unauthenticated write surface in the application, so it carries its
// own limits rather than relying on proxy.ts.
//
// Absent, expired, revoked and malformed claims all return the SAME status and
// body. Distinguishing them would turn this into an oracle for which claims
// exist. Nothing here logs the request or the response.

export const dynamic = "force-dynamic";

const REFUSED = { error: "That claim cannot be used." };

function clientIp(req: NextRequest): string {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
    return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest) {
    const { attemptId, limited } = await beginClaimAttempt(hashClientIp(clientIp(req)));
    if (limited) {
        return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    }
    try {
        const body = await req.json().catch(() => ({}));
        const claim = typeof body.claim === "string" ? body.claim.trim() : "";
        const result = claim ? await exchangeClaim(claim) : null;
        if (!result) return NextResponse.json(REFUSED, { status: 400 });

        await finishClaimAttempt(attemptId, true);
        return NextResponse.json({
            key: result.key,
            client: result.client,
            scopes: result.scopes,
            accessLevel: result.accessLevel,
        });
    } catch {
        // Deliberately opaque: the message could distinguish failure modes.
        return NextResponse.json(REFUSED, { status: 400 });
    }
}
