import { NextRequest, NextResponse } from "next/server";
import {
    generateAuthenticationOptions, generateRegistrationOptions,
    verifyAuthenticationResponse, verifyRegistrationResponse,
    type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { AUTH_CHALLENGE_COOKIE, authOrigin, authOwnerName, authRpId } from "@/lib/auth/config";
import { createSessionValue, sessionCookie, verifySessionValue } from "@/lib/auth/session";
import { validPassword } from "@/lib/auth/server";
import {
    consumeChallenge, createChallenge, deletePasskey, findPasskey, getChallenge,
    listPasskeys, savePasskey, updatePasskeyUse,
} from "@/lib/auth/store";

function challengeCookie(id: string) {
    return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 5 * 60, value: id };
}

async function signedIn(req: NextRequest) {
    return verifySessionValue(req.cookies.get("zuychin-auth")?.value);
}

export async function GET(req: NextRequest) {
    if (!await signedIn(req)) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    try {
        const passkeys = await listPasskeys();
        return NextResponse.json({ passkeys: passkeys.map(({ credentialId, deviceType, backedUp, createdAt, lastUsedAt }) => ({ credentialId, deviceType, backedUp, createdAt, lastUsedAt })) });
    } catch {
        return NextResponse.json({ error: "Passkey storage is not configured. Apply the authentication SQL migration." }, { status: 503 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const action = body.action as string;

        if (action === "authentication-options") {
            const options = await generateAuthenticationOptions({ rpID: authRpId(), userVerification: "required", timeout: 60_000 });
            const id = await createChallenge("passkey_auth", options.challenge);
            const res = NextResponse.json(options);
            res.cookies.set(AUTH_CHALLENGE_COOKIE, id, challengeCookie(id));
            return res;
        }

        if (action === "authentication-verify") {
            const challengeId = req.cookies.get(AUTH_CHALLENGE_COOKIE)?.value;
            const challenge = challengeId ? await getChallenge(challengeId, "passkey_auth") : null;
            const response = body.response as AuthenticationResponseJSON;
            if (!challenge || !response?.id) return NextResponse.json({ error: "Your sign-in request expired. Try again." }, { status: 400 });
            const passkey = await findPasskey(response.id);
            if (!passkey) return NextResponse.json({ error: "This passkey is not registered for Zuychin." }, { status: 401 });
            const verified = await verifyAuthenticationResponse({
                response, expectedChallenge: challenge.challenge, expectedOrigin: authOrigin(), expectedRPID: authRpId(), requireUserVerification: true,
                credential: { id: passkey.credentialId, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64")), counter: passkey.counter, transports: passkey.transports },
            });
            if (!verified.verified || !verified.authenticationInfo.userVerified) return NextResponse.json({ error: "Passkey verification failed." }, { status: 401 });
            await updatePasskeyUse(passkey.credentialId, verified.authenticationInfo.newCounter);
            await consumeChallenge(challengeId!, "passkey_auth");
            const res = NextResponse.json({ ok: true });
            res.cookies.set(sessionCookie(await createSessionValue()));
            res.cookies.set(AUTH_CHALLENGE_COOKIE, "", { path: "/", maxAge: 0 });
            return res;
        }

        if (!await signedIn(req)) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

        if (action === "registration-options") {
            if (!validPassword(body.password)) return NextResponse.json({ error: "Confirm your password before adding a passkey." }, { status: 401 });
            const passkeys = await listPasskeys();
            const options = await generateRegistrationOptions({
                rpName: "Zuychin Assistant", rpID: authRpId(), userID: new TextEncoder().encode("zuychin-owner"), userName: authOwnerName(), userDisplayName: authOwnerName(),
                attestationType: "none", timeout: 60_000,
                excludeCredentials: passkeys.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports as never })),
                authenticatorSelection: { residentKey: "required", userVerification: "required" },
            });
            const id = await createChallenge("passkey_register", options.challenge);
            const res = NextResponse.json(options);
            res.cookies.set(AUTH_CHALLENGE_COOKIE, id, challengeCookie(id));
            return res;
        }

        if (action === "registration-verify") {
            const challengeId = req.cookies.get(AUTH_CHALLENGE_COOKIE)?.value;
            const challenge = challengeId ? await getChallenge(challengeId, "passkey_register") : null;
            const response = body.response as RegistrationResponseJSON;
            if (!challenge || !response) return NextResponse.json({ error: "Your passkey setup expired. Try again." }, { status: 400 });
            const verified = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: authOrigin(), expectedRPID: authRpId(), requireUserVerification: true });
            if (!verified.verified || !verified.registrationInfo.userVerified) return NextResponse.json({ error: "Passkey registration failed." }, { status: 400 });
            const info = verified.registrationInfo;
            await savePasskey({
                credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString("base64"), counter: info.credential.counter,
                transports: response.response.transports ?? [], deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
            });
            await consumeChallenge(challengeId!, "passkey_register");
            const res = NextResponse.json({ ok: true });
            res.cookies.set(AUTH_CHALLENGE_COOKIE, "", { path: "/", maxAge: 0 });
            return res;
        }

        if (action === "delete") {
            if (!validPassword(body.password)) return NextResponse.json({ error: "Confirm your password before removing a passkey." }, { status: 401 });
            const passkeys = await listPasskeys();
            if (passkeys.length <= 1) return NextResponse.json({ error: "Keep at least one passkey registered." }, { status: 400 });
            await deletePasskey(body.credentialId);
            return NextResponse.json({ ok: true });
        }
        return NextResponse.json({ error: "Unknown passkey action." }, { status: 400 });
    } catch (error) {
        console.error("[Auth] Passkey operation failed:", error);
        return NextResponse.json({ error: "Passkey authentication is not configured yet. Apply the authentication SQL migration first." }, { status: 503 });
    }
}
