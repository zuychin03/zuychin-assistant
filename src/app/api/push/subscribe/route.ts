import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { AUTH_COOKIE, authEnabled } from "@/lib/auth/config";
import { verifySessionValue } from "@/lib/auth/session";

// web-push needs Node; keep this route off the edge runtime.
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const reply = (body: { registered: boolean } | { error: string }, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) return reply({ error: "Use this site's owner session." }, 403);
    if (authEnabled() && !await verifySessionValue(req.cookies.get(AUTH_COOKIE)?.value)) return reply({ error: "Sign in to check browser alerts." }, 401);
    const endpoint = req.headers.get("x-push-endpoint");
    if (!endpoint || endpoint.length > 4096) return reply({ error: "A valid browser endpoint is required." }, 400);
    try {
        const url = new URL(endpoint);
        if (url.protocol !== "https:" || url.username || url.password || url.hash) return reply({ error: "A valid browser endpoint is required." }, 400);
    } catch { return reply({ error: "A valid browser endpoint is required." }, 400); }
    try {
        const { data, error } = await supabase.from("push_subscriptions").select("id").eq("endpoint", endpoint).maybeSingle();
        if (error) throw error;
        return reply({ registered: data !== null });
    } catch { return reply({ error: "Browser alert status could not be verified." }, 503); }
}

export async function POST(req: NextRequest) {
    let sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    try {
        sub = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
        return NextResponse.json({ error: "endpoint and keys are required" }, { status: 400 });
    }

    const { error } = await supabase
        .from("push_subscriptions")
        .upsert(
            {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
                user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
            },
            { onConflict: "endpoint" }
        );

    if (error) {
        console.error("[Push] Subscribe failed:", error.message);
        return NextResponse.json({ error: "Failed to store subscription - has the DDL been run?" }, { status: 503 });
    }
    return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
    let endpoint = "";
    try {
        endpoint = ((await req.json()) as { endpoint?: string }).endpoint ?? "";
    } catch { }
    if (!endpoint) {
        return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
    }

    const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    if (error) {
        console.error("[Push] Unsubscribe failed:", error.message);
        return NextResponse.json({ error: "Failed to remove subscription" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
}
