import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authEnabled } from "@/lib/auth/config";
import { verifySessionValue } from "@/lib/auth/session";

const PUBLIC_PATHS = [
  "/login", "/api/auth", "/api/webhooks", "/api/cron", "/api/chat", "/api/telegram", "/api/mcp", "/api/knowledge/webhook",
  // An agent exchanges its claim before it holds any credential, so this one
  // cannot be session-gated. It carries its own rate limit. Note that the
  // owner-only /api/agents routes are a different prefix and stay gated.
  "/api/agent/claim",
  // Browsers fetch the manifest and service worker without cookies; gating
  // them silently breaks PWA install.
  "/manifest.webmanifest", "/sw.js", "/icons",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function isStaticAsset(pathname: string): boolean {
  return pathname.startsWith("/_next") || pathname.startsWith("/favicon") || pathname.endsWith(".svg") || pathname.endsWith(".png") || pathname.endsWith(".ico");
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isStaticAsset(pathname) || isPublicPath(pathname)) return NextResponse.next();
  if (!authEnabled()) return NextResponse.next();
  if (await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
