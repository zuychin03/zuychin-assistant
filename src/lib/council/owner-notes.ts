import { supabaseAdmin as supabase } from "@/lib/supabase";

// Owner notes reach seats only through work-campaign surfaces (heartbeat,
// council_work_next and the host's campaign prompt). They are never debate
// messages, so a closed Council keeps refusing those.

export const OWNER_NOTE_MAX_CHARS = 4000;

export interface CouncilOwnerNote {
    id: string;
    agentName: string | null;
    body: string;
    createdAt: string;
    /** Seat name to the time that seat was given the note. */
    delivered: Record<string, string>;
}

export type OwnerNoteRefusal =
    | "unknown_session" | "not_closed" | "no_campaign" | "campaign_finished" | "unknown_seat" | "invalid_body" | "not_installed";

export type RequeueRefusal = "unknown_item" | "manifest_frozen" | "campaign_finished" | "not_blocked" | "not_installed";

interface NoteRow { id: string; agent_name: string | null; body: string; created_at: string; delivered?: Record<string, string> | null }

const mapNote = (row: NoteRow): CouncilOwnerNote => ({
    id: row.id, agentName: row.agent_name, body: row.body, createdAt: row.created_at, delivered: row.delivered ?? {},
});

// D22: before council-owner-notes.sql is applied, notes are refused with a clear
// reason and delivery quietly finds nothing.
function notInstalled(message: string): boolean {
    return /does not exist|schema cache|could not find the (table|function)/i.test(message);
}

export async function addOwnerNote(params: { sessionId: string; agentName: string | null; body: string }):
Promise<{ ok: true; note: CouncilOwnerNote } | { ok: false; reason: OwnerNoteRefusal }> {
    const { data, error } = await supabase.rpc("add_council_owner_note", {
        p_session_id: params.sessionId, p_agent_name: params.agentName, p_body: params.body,
    });
    if (error) {
        if (notInstalled(error.message)) return { ok: false, reason: "not_installed" };
        throw new Error(error.message);
    }
    const result = data as { ok?: boolean; reason?: OwnerNoteRefusal; note?: NoteRow } | null;
    if (result?.ok === true && result.note) return { ok: true, note: mapNote(result.note) };
    return { ok: false, reason: result?.reason ?? "invalid_body" };
}

export async function listOwnerNotes(sessionId: string): Promise<{ installed: boolean; notes: CouncilOwnerNote[] }> {
    const { data, error } = await supabase.from("council_owner_notes")
        .select("id, agent_name, body, created_at, delivered")
        .eq("session_id", sessionId).order("created_at", { ascending: true }).limit(200);
    if (error) {
        if (notInstalled(error.message)) return { installed: false, notes: [] };
        throw new Error(error.message);
    }
    return { installed: true, notes: (data ?? []).map((row) => mapNote(row as NoteRow)) };
}

/**
 * Hands a seat its undelivered notes and marks them delivered. Only the notes
 * this call marked are returned, so concurrent callers never deliver one twice.
 * Never throws: a delivery failure must not fail the heartbeat or claim it rides on.
 */
export async function takeOwnerNotes(sessionId: string, agentName: string): Promise<CouncilOwnerNote[]> {
    try {
        const pending = await supabase.rpc("pending_council_owner_notes", { p_session_id: sessionId, p_agent_name: agentName });
        if (pending.error) throw new Error(pending.error.message);
        const rows = (pending.data ?? []) as NoteRow[];
        if (rows.length === 0) return [];
        const marked = await supabase.rpc("mark_council_owner_notes_delivered", {
            p_ids: rows.map((row) => row.id), p_agent_name: agentName,
        });
        if (marked.error) throw new Error(marked.error.message);
        const ids = new Set(((marked.data ?? []) as unknown[]).map(String));
        return rows.filter((row) => ids.has(row.id)).map(mapNote);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!notInstalled(message)) console.warn("[Council] owner note delivery failed:", message);
        return [];
    }
}

export function renderOwnerNotes(notes: Pick<CouncilOwnerNote, "body">[]): string {
    return notes.map((note) => "=== OWNER NOTE (from the owner, delivered by the Zuychin server) ===\n"
        + note.body + "\n=== END OWNER NOTE ===").join("\n\n");
}

export async function requeueWorkItem(itemId: string): Promise<{ ok: true } | { ok: false; reason: RequeueRefusal }> {
    const { data, error } = await supabase.rpc("requeue_council_work_item", { p_item_id: itemId });
    if (error) {
        if (notInstalled(error.message)) return { ok: false, reason: "not_installed" };
        throw new Error(error.message);
    }
    const result = data as { ok?: boolean; reason?: RequeueRefusal } | null;
    return result?.ok === true ? { ok: true } : { ok: false, reason: result?.reason ?? "not_blocked" };
}
