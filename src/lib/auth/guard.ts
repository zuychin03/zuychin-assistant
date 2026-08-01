import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { AUTH_COOKIE, authEnabled } from "./config";
import { verifySessionValue } from "./session";

// proxy.ts cannot gate these: the routes are in PUBLIC_PATHS because the Discord
// bot and the cron caller reach them without a browser session. They therefore
// have to authenticate themselves, and until they did, /api/chat exposed the
// whole RAG store, the model budget and every agent tool to anyone with the URL.

function secretMatches(provided: string | null, expected: string | undefined): boolean {
    if (!expected || !provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: NextRequest): string | null {
    const header = req.headers.get("authorization");
    return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

// The reason is safe to state and is the whole diagnostic: a cron caller sees
// only the status code, and "missing header" and "wrong secret" need completely
// different fixes. It reveals nothing the caller does not already know - never
// the expected value, its length, or how close a wrong one was.
function unauthorized(reason?: string) {
    return NextResponse.json({ error: "Unauthorized", ...(reason ? { reason } : {}) }, { status: 401 });
}

/**
 * Guards a route that serves both the signed-in web app and a headless caller.
 * Returns a response to send back, or null when the request may proceed.
 */
export async function requireChatAuth(req: NextRequest): Promise<NextResponse | null> {
    // Matches the middleware: with auth switched off there is nothing to enforce.
    if (!authEnabled()) return null;
    if (await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return null;
    if (secretMatches(bearer(req), process.env.CHAT_API_KEY)) return null;
    return unauthorized();
}

/**
 * Cron endpoints trigger briefings, outbound messages and task runs, so a
 * missing CRON_SECRET must refuse the request rather than wave it through.
 */
export function requireCron(req: NextRequest): NextResponse | null {
    const expected = process.env.CRON_SECRET;
    if (!expected) {
        if (process.env.NODE_ENV === "production") {
            console.error("[Auth] CRON_SECRET is not set; refusing cron request.");
            return unauthorized("CRON_SECRET is not configured on the server");
        }
        return null;
    }
    const provided = bearer(req);
    if (!provided) {
        const header = req.headers.get("authorization");
        return unauthorized(header
            ? "Authorization header is not a Bearer token; it must read exactly: Bearer <CRON_SECRET>"
            : "no Authorization header; this endpoint needs: Authorization: Bearer <CRON_SECRET>");
    }
    return secretMatches(provided, expected) ? null : unauthorized("bearer token does not match CRON_SECRET");
}
