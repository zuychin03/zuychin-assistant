import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authEnabled, authOrigin } from "@/lib/auth/config";
import { verifySessionValue } from "@/lib/auth/session";

const PUBLIC_PATHS = [
  "/login", "/api/webhooks", "/api/cron", "/api/chat", "/api/telegram/webhook", "/api/mcp", "/api/knowledge/webhook",
  // Sign-in ceremonies run before a session exists. /api/auth/google prints
  // OAuth tokens, so it is deliberately not listed.
  "/api/auth/passkey", "/api/auth/totp",
  // An agent exchanges its claim before it holds any credential, so this one
  // cannot be session-gated. It carries its own rate limit. Note that the
  // owner-only /api/agents routes are a different prefix and stay gated.
  "/api/agent/claim",
  // Browsers fetch the manifest and service worker without cookies; gating
  // them silently breaks PWA install.
  "/manifest.webmanifest", "/sw.js", "/icons", "/offline.html", "/offline-reader.js", "/offline-reader.css",
];
// Password sign-in and sign-out; prefix matching would also open /api/auth/google.
const PUBLIC_EXACT = new Set(["/api/auth"]);

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) return true;
  // A dynamic API segment ending in .png must not skip the session check.
  return !pathname.startsWith("/api/") && (pathname.endsWith(".svg") || pathname.endsWith(".png") || pathname.endsWith(".ico"));
}

// SameSite=Lax already keeps other sites' requests cookieless; this also refuses
// sibling subdomains, which count as same-site. Bearer callers send no cookie and
// no Origin, so the bot, crons, webhooks and MCP clients are unaffected.
function crossOriginMutation(req: NextRequest): boolean {
  if (!UNSAFE_METHODS.has(req.method) || !req.cookies.has(AUTH_COOKIE)) return false;
  const origin = req.headers.get("origin");
  return origin !== null && origin !== authOrigin() && origin !== req.nextUrl.origin;
}

function secured(res: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value);
  if (process.env.NODE_ENV === "production") res.headers.set("Strict-Transport-Security", "max-age=31536000");
  return res;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (crossOriginMutation(req)) return secured(NextResponse.json({ error: "Cross-site request refused." }, { status: 403 }));
  if (isStaticAsset(pathname) || isPublicPath(pathname)) return secured(NextResponse.next());
  if (!authEnabled()) return secured(NextResponse.next());
  if (await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return secured(NextResponse.next());
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  return secured(NextResponse.redirect(loginUrl));
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
