export const AUTH_COOKIE = "zuychin-auth";
export const AUTH_CHALLENGE_COOKIE = "zuychin-auth-challenge";
export const AUTH_RECOVERY_COOKIE = "zuychin-auth-recovery";
export const AUTH_OWNER_ID = "owner";

// Fails closed. Keying this on ACCESS_PASSWORD alone meant a passkey-only
// deployment - one that drops the password and keeps AUTH_SESSION_SECRET - left
// every page open with no error, and so did a deploy that simply lost its env.
export function authEnabled() {
    if (process.env.ACCESS_PASSWORD || process.env.AUTH_SESSION_SECRET) return true;
    return process.env.NODE_ENV === "production";
}

export function authRpId() {
    if (process.env.AUTH_RP_ID) return process.env.AUTH_RP_ID;
    if (process.env.VERCEL_URL) return process.env.VERCEL_URL;
    return "localhost";
}

export function authOrigin() {
    if (process.env.AUTH_ORIGIN) return process.env.AUTH_ORIGIN.replace(/\/$/, "");
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return "http://localhost:3000";
}

export function authOwnerName() {
    return process.env.AUTH_OWNER_NAME || "Zuychin owner";
}

export function totpIssuer() {
    return process.env.AUTH_TOTP_ISSUER || "Zuychin Assistant";
}

export function authSecret() {
    // A dedicated high-entropy secret is required in production. The password
    // fallback keeps an existing installation usable until it is configured.
    const secret = process.env.AUTH_SESSION_SECRET || process.env.ACCESS_PASSWORD;
    if (!secret) throw new Error("Set AUTH_SESSION_SECRET before enabling authentication.");
    return secret;
}
