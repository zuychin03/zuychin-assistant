import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { AUTH_RECOVERY_COOKIE } from "@/lib/auth/config";
import { createSessionValue, sessionCookie, verifySessionValue } from "@/lib/auth/session";
import { createTotp, encryptTotpSecret, validPassword, validTotpCode } from "@/lib/auth/server";
import { consumeChallenge, enableTotp, getChallenge, getTotpConfig, registerFailedChallengeAttempt, saveTotpConfig } from "@/lib/auth/store";

async function signedIn(req: NextRequest) {
    return verifySessionValue(req.cookies.get("zuychin-auth")?.value);
}

export async function GET(req: NextRequest) {
    if (!await signedIn(req)) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    try {
        const config = await getTotpConfig();
        return NextResponse.json({ enabled: config?.enabled ?? false });
    } catch {
        return NextResponse.json({ error: "Authenticator-app recovery is not configured. Apply the authentication SQL migration." }, { status: 503 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        if (body.action === "recover") {
            const challengeId = req.cookies.get(AUTH_RECOVERY_COOKIE)?.value;
            const challenge = challengeId ? await getChallenge(challengeId, "totp_recovery") : null;
            const config = await getTotpConfig();
            if (!challenge || !config?.enabled) return NextResponse.json({ error: "Your recovery request expired. Enter your password again." }, { status: 400 });
            if (!validTotpCode(config.ciphertext, body.code)) {
                await registerFailedChallengeAttempt(challengeId!);
                return NextResponse.json({ error: "Incorrect authenticator code." }, { status: 401 });
            }
            await consumeChallenge(challengeId!, "totp_recovery");
            const res = NextResponse.json({ ok: true });
            res.cookies.set(sessionCookie(await createSessionValue()));
            res.cookies.set(AUTH_RECOVERY_COOKIE, "", { path: "/", maxAge: 0 });
            return res;
        }

        if (!await signedIn(req)) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
        if (!validPassword(body.password)) return NextResponse.json({ error: "Confirm your password first." }, { status: 401 });

        if (body.action === "setup") {
            const totp = createTotp();
            const secret = totp.secret.base32;
            await saveTotpConfig(encryptTotpSecret(secret));
            return NextResponse.json({ secret, uri: totp.toString(), qrCode: await QRCode.toDataURL(totp.toString()) });
        }
        if (body.action === "verify") {
            const config = await getTotpConfig();
            if (!config || !validTotpCode(config.ciphertext, body.code)) return NextResponse.json({ error: "Incorrect authenticator code." }, { status: 401 });
            await enableTotp();
            return NextResponse.json({ ok: true });
        }
        return NextResponse.json({ error: "Unknown authenticator action." }, { status: 400 });
    } catch (error) {
        console.error("[Auth] Authenticator-app operation failed:", error);
        return NextResponse.json({ error: "Authenticator-app recovery is not configured yet. Apply the authentication SQL migration first." }, { status: 503 });
    }
}
