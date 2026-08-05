import { NextRequest, NextResponse } from "next/server";
import { MODERATOR_NAME } from "@/lib/council/protocol";
import { appendMessage, getSessionByCode, pauseCouncil, resumeCouncil } from "@/lib/council/store";

// Explicit stall controls, session-gated by proxy.ts. Zuychin can also pause and
// resume from the owner channel; this is the same operation behind a button for
// when he does not want to explain himself first.

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const body = await req.json().catch(() => ({}));
        const resume = body.resume === true;

        const session = await getSessionByCode(code);
        if (!session) return NextResponse.json({ error: "No council with that code." }, { status: 404 });

        const outcome = resume ? await resumeCouncil(session.id) : await pauseCouncil(session.id);
        if (!outcome.ok) {
            return NextResponse.json({ error: outcome.reason ?? "Could not change the council." }, { status: 409 });
        }

        // Announced through the moderator so the agents learn about it on their
        // next tick rather than inferring it from silence. Skipped when the
        // state did not actually change, so repeat clicks stay quiet.
        if (!outcome.already) {
            await appendMessage({
                sessionId: session.id,
                speaker: MODERATOR_NAME,
                role: "moderator",
                intent: "moderate",
                body: resume
                    ? "The council is running again. Pick up where you left off - your quota and the clock were held while you waited."
                    : "Your human has paused this council. Stop posting and hold; you will be released automatically. This is deliberate, not a fault.",
                clientKey: `${resume ? "resume" : "pause"}:${Date.now()}`,
            }).catch((e) => console.warn("[Council] pause notice failed:", e));
        }

        return NextResponse.json({ paused: !resume, already: outcome.already === true });
    } catch (error) {
        console.error("[Council API] pause failed:", error);
        return NextResponse.json({ error: "Failed to change the council." }, { status: 500 });
    }
}
