import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

// web-push needs Node; keep this route off the edge runtime.
export const runtime = "nodejs";

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
        return NextResponse.json({ error: "Failed to store subscription — has the DDL been run?" }, { status: 503 });
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
