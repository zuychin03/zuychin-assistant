import { randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { SCOPES } from "@/lib/google-auth";
import { AUTH_COOKIE, authOrigin } from "@/lib/auth/config";
import { verifySessionValue } from "@/lib/auth/session";

const STATE_COOKIE = "zuychin-google-state";
const stateCookie = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/api/auth/google" };

function stateMatches(given: string | null, expected: string | undefined): boolean {
    if (!given || !expected) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
    if (!await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

    const code = req.nextUrl.searchParams.get("code");

    if (!code) {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            return NextResponse.json(
                { error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local first." },
                { status: 500 }
            );
        }

        const oauth2 = new google.auth.OAuth2(
            clientId,
            clientSecret,
            `${authOrigin()}/api/auth/google/callback`
        );

        const state = randomBytes(24).toString("base64url");
        const authUrl = oauth2.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: SCOPES,
            state,
        });

        const res = NextResponse.redirect(authUrl);
        res.cookies.set(STATE_COOKIE, state, { ...stateCookie, maxAge: 600 });
        return res;
    }

    if (!stateMatches(req.nextUrl.searchParams.get("state"), req.cookies.get(STATE_COOKIE)?.value)) {
        return NextResponse.json({ error: "This Google sign-in expired. Start it again." }, { status: 400 });
    }

    try {
        const clientId = process.env.GOOGLE_CLIENT_ID!;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;

        const oauth2 = new google.auth.OAuth2(
            clientId,
            clientSecret,
            `${authOrigin()}/api/auth/google/callback`
        );

        const { tokens } = await oauth2.getToken(code);

        const html = `
<!DOCTYPE html>
<html>
<head><title>Google OAuth Setup</title>
<style>
    body { font-family: system-ui; max-width: 600px; margin: 60px auto; padding: 20px; background: #111; color: #eee; }
    h1 { color: #4ade80; }
    code { background: #222; padding: 8px 14px; border-radius: 6px; display: block; word-break: break-all; margin: 12px 0; font-size: 13px; color: #facc15; }
    .label { font-weight: 600; margin-top: 20px; }
</style>
</head>
<body>
    <h1>✅ Google OAuth Complete</h1>
    <p>Copy the refresh token below and add it to <strong>.env.local</strong>:</p>
    <p class="label">GOOGLE_REFRESH_TOKEN</p>
    <code>${tokens.refresh_token || "⚠️ No refresh token returned. Revoke access at myaccount.google.com/permissions and try again."}</code>
    ${tokens.access_token ? `<p class="label">Access Token (temporary)</p><code>${tokens.access_token}</code>` : ""}
    <p style="margin-top: 30px; color: #888;">After adding the token to .env.local, restart the dev server.</p>
</body>
</html>`;

        const res = new NextResponse(html, {
            headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        });
        res.cookies.set(STATE_COOKIE, "", { ...stateCookie, maxAge: 0 });
        return res;
    } catch (error) {
        console.error("[Google OAuth] Token exchange error:", error);
        return NextResponse.json(
            { error: "Failed to exchange authorization code." },
            { status: 500 }
        );
    }
}
