import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authEnabled, sameOrigin } from "@/lib/auth/config";
import { createSessionValue, sessionCookie, verifySessionValue } from "@/lib/auth/session";
import { checkPassword, clientAddress, TOO_MANY_ATTEMPTS } from "@/lib/auth/attempts";
import { SessionEpochMissingError, sessionEpochStatus, signOutEverywhere } from "@/lib/auth/session-epoch";
import { bodyFailure, readJsonCapped } from "@/lib/http/body";

async function ownerRefusal(req: NextRequest): Promise<NextResponse | null> {
    if (!authEnabled()) return NextResponse.json({ error: "Sign-in is off, so there are no sessions to sign out." }, { status: 409 });
    if (!await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    if (!sameOrigin(req)) return NextResponse.json({ error: "This must come from the app." }, { status: 403 });
    return null;
}

export async function GET(req: NextRequest) {
    const refused = await ownerRefusal(req);
    if (refused) return refused;
    try {
        return NextResponse.json(await sessionEpochStatus());
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "The sign-out time could not be read." }, { status: 503 });
    }
}

/** Signs out every other browser and device; this browser gets a fresh cookie and stays signed in. */
export async function POST(req: NextRequest) {
    const refused = await ownerRefusal(req);
    if (refused) return refused;
    let body: { action?: unknown; password?: unknown };
    try { body = await readJsonCapped(req); } catch (error) { return bodyFailure(error) ?? NextResponse.json({ error: "Could not read the request." }, { status: 400 }); }
    if (body?.action !== "sign_out_everywhere") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    const checked = checkPassword(clientAddress(req.headers), body.password);
    if (checked === "blocked") return NextResponse.json({ error: TOO_MANY_ATTEMPTS }, { status: 429 });
    if (checked === "wrong") return NextResponse.json({ error: "Enter your current password to sign out everywhere." }, { status: 401 });
    try {
        const validAfter = await signOutEverywhere();
        const res = NextResponse.json({ ok: true, validAfter: new Date(validAfter * 1000).toISOString() });
        res.cookies.set(sessionCookie(await createSessionValue()));
        return res;
    } catch (error) {
        const message = error instanceof SessionEpochMissingError ? error.message : error instanceof Error ? error.message : "Sign out everywhere failed.";
        return NextResponse.json({ error: message }, { status: 503 });
    }
}
