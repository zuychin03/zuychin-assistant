import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode, readOwnerThread } from "@/lib/council/store";
import { ownerTurn } from "@/lib/council/owner-channel";

// The owner's private channel into a running council. Session-gated by
// proxy.ts, which covers everything outside PUBLIC_PATHS - and deliberately NOT
// exposed on the MCP server, because this is the one surface the agents must
// never be able to reach.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404 });
        return NextResponse.json({
            thread: await readOwnerThread(session.id),
            paused: session.pausedAt !== null,
        });
    } catch (error) {
        console.error("[Council API] owner thread failed:", error);
        return NextResponse.json({ error: "Failed to load the thread." }, { status: 500 });
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const body = await req.json().catch(() => ({}));
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return NextResponse.json({ error: "Say something first." }, { status: 400 });

        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404 });
        if (session.status === "closed") {
            return NextResponse.json({ error: "That council is closed." }, { status: 409 });
        }

        const outcome = await ownerTurn({ session, text });
        return NextResponse.json({
            ...outcome,
            thread: await readOwnerThread(session.id),
        });
    } catch (error) {
        console.error("[Council API] owner turn failed:", error);
        return NextResponse.json({ error: "Failed to send that." }, { status: 500 });
    }
}
