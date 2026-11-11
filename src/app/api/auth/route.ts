import { NextRequest, NextResponse } from "next/server";
import { AUTH_CHALLENGE_COOKIE, AUTH_RECOVERY_COOKIE, authEnabled } from "@/lib/auth/config";
import { createSessionValue, sessionCookie } from "@/lib/auth/session";
import { createChallenge, getTotpConfig } from "@/lib/auth/store";
import { checkPassword, clientAddress, TOO_MANY_ATTEMPTS } from "@/lib/auth/attempts";

const clearCookie = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
};

export async function POST(req: NextRequest) {
    const { password } = await req.json();
    if (!authEnabled()) return NextResponse.json({ error: "Access password not configured" }, { status: 500 });
    const checked = checkPassword(clientAddress(req.headers), password);
    if (checked === "blocked") return NextResponse.json({ error: TOO_MANY_ATTEMPTS }, { status: 429 });
    if (checked === "wrong") return NextResponse.json({ error: "Wrong password" }, { status: 401 });
    // Fails closed: when TOTP state cannot be read, the password alone must not
    // stand in for a second factor that may be switched on.
    try {
        const totp = await getTotpConfig();
        if (totp?.enabled) {
            const challengeId = await createChallenge("totp_recovery", crypto.randomUUID());
            const res = NextResponse.json({ ok: true, requiresTotp: true });
            res.cookies.set(AUTH_RECOVERY_COOKIE, challengeId, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 5 * 60 });
            return res;
        }
    } catch (error) {
        console.error("[Auth] TOTP check failed; refusing password sign-in:", error);
        return NextResponse.json({ error: "Sign-in is unavailable right now. Try again shortly, or use a passkey." }, { status: 503 });
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(sessionCookie(await createSessionValue()));
    return res;
}

export async function DELETE() {
    const res = NextResponse.json({ ok: true });
    res.cookies.set("zuychin-auth", "", clearCookie);
    res.cookies.set(AUTH_CHALLENGE_COOKIE, "", clearCookie);
    res.cookies.set(AUTH_RECOVERY_COOKIE, "", clearCookie);
    return res;
}
