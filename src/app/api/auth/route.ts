import { NextRequest, NextResponse } from "next/server";
import { AUTH_CHALLENGE_COOKIE, AUTH_RECOVERY_COOKIE, authEnabled } from "@/lib/auth/config";
import { createSessionValue, sessionCookie } from "@/lib/auth/session";
import { validPassword } from "@/lib/auth/server";
import { createChallenge, getTotpConfig } from "@/lib/auth/store";

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
    if (!validPassword(password)) return NextResponse.json({ error: "Wrong password" }, { status: 401 });
    try {
        const totp = await getTotpConfig();
        if (totp?.enabled) {
            const challengeId = await createChallenge("totp_recovery", crypto.randomUUID());
            const res = NextResponse.json({ ok: true, requiresTotp: true });
            res.cookies.set(AUTH_RECOVERY_COOKIE, challengeId, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 5 * 60 });
            return res;
        }
    } catch (error) {
        console.warn("[Auth] TOTP lookup unavailable:", error);
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
