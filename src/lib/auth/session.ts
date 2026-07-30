import { AUTH_COOKIE, authSecret } from "./config";

type AuthSession = {
    exp: number;
    nonce: string;
    v: 1;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function base64Url(bytes: Uint8Array) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(value: string) {
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(authSecret()),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
    if (left.length !== right.length) return false;
    let mismatch = 0;
    for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
    return mismatch === 0;
}

export async function createSessionValue() {
    const session: AuthSession = {
        v: 1,
        exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
        nonce: base64Url(crypto.getRandomValues(new Uint8Array(24))),
    };
    const payload = base64Url(encoder.encode(JSON.stringify(session)));
    return `${payload}.${base64Url(await hmac(payload))}`;
}

export async function verifySessionValue(value?: string) {
    if (!value) return false;
    const [payload, signature, ...extra] = value.split(".");
    if (!payload || !signature || extra.length > 0) return false;
    try {
        if (!equalBytes(fromBase64Url(signature), await hmac(payload))) return false;
        const session = JSON.parse(decoder.decode(fromBase64Url(payload))) as AuthSession;
        return session.v === 1 && Number.isSafeInteger(session.exp) && session.exp > Math.floor(Date.now() / 1000);
    } catch {
        return false;
    }
}

export function sessionCookie(value: string, maxAge = SESSION_MAX_AGE_SECONDS) {
    return {
        name: AUTH_COOKIE,
        value,
        options: {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax" as const,
            path: "/",
            maxAge,
        },
    };
}
