import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { SCOPES } from "@/lib/google-auth";

// OAuth callback — exchanges auth code for tokens (one-time setup)
export async function GET(req: NextRequest) {
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
            `${req.nextUrl.origin}/api/auth/google/callback`
        );

        const authUrl = oauth2.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: SCOPES,
        });

        return NextResponse.redirect(authUrl);
    }

    try {
        const clientId = process.env.GOOGLE_CLIENT_ID!;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;

        const oauth2 = new google.auth.OAuth2(
            clientId,
            clientSecret,
            `${req.nextUrl.origin}/api/auth/google/callback`
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

        return new NextResponse(html, {
            headers: { "Content-Type": "text/html" },
        });
    } catch (error) {
        console.error("[Google OAuth] Token exchange error:", error);
        return NextResponse.json(
            { error: "Failed to exchange authorization code.", details: String(error) },
            { status: 500 }
        );
    }
}
