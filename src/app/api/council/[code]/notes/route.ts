import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/lib/auth/config";
import { addOwnerNote, listOwnerNotes, OWNER_NOTE_MAX_CHARS, type OwnerNoteRefusal } from "@/lib/council/owner-notes";
import { getSessionByCode } from "@/lib/council/store";

// Owner notes to the seats of a closed Council whose campaign is still going.
// Session-gated by proxy.ts. Seats read them at their next heartbeat, claim or
// campaign prompt; they never become debate messages.

const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

const REFUSALS: Record<OwnerNoteRefusal, [number, string]> = {
    unknown_session: [404, "No council with that code."],
    not_closed: [409, "Notes go to the seats once the debate has closed and its work campaign is running."],
    no_campaign: [409, "This council has no work campaign, so no seat would read the note."],
    campaign_finished: [409, "The work campaign has finished, so no seat would read the note."],
    unknown_seat: [400, "Pick one of this council's seats, or all seats."],
    invalid_body: [400, `Write a note of 1 to ${OWNER_NOTE_MAX_CHARS} characters.`],
    not_installed: [503, "Owner notes need scripts/migrations/council-owner-notes.sql applied in Supabase first."],
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const session = await getSessionByCode(code);
        if (!session) return respond({ error: "No council with that code." }, 404);
        return respond(await listOwnerNotes(session.id));
    } catch (error) {
        console.error("[Council API] owner notes read failed:", error);
        return respond({ error: "Could not read the notes." }, 500);
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    if (!sameOrigin(req)) return respond({ error: "Send notes from this site." }, 403);
    try {
        const { code } = await params;
        const body = await req.json().catch(() => null) as { text?: unknown; agent?: unknown } | null;
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text || text.length > OWNER_NOTE_MAX_CHARS) return respond({ error: REFUSALS.invalid_body[1] }, 400);
        if (body?.agent !== undefined && body.agent !== null && typeof body.agent !== "string") return respond({ error: REFUSALS.unknown_seat[1] }, 400);
        const agentName = typeof body?.agent === "string" && body.agent.trim() ? body.agent.trim() : null;

        const session = await getSessionByCode(code);
        if (!session) return respond({ error: REFUSALS.unknown_session[1] }, 404);
        const result = await addOwnerNote({ sessionId: session.id, agentName, body: text });
        if (!result.ok) {
            const [status, error] = REFUSALS[result.reason];
            return respond({ error, reason: result.reason }, status);
        }
        // The note is saved; a failed re-read must not invite a duplicate send.
        const list = await listOwnerNotes(session.id).catch(() => ({ installed: true, notes: [result.note] }));
        return respond({ note: result.note, ...list });
    } catch (error) {
        console.error("[Council API] owner note failed:", error);
        return respond({ error: "Could not send the note." }, 500);
    }
}
