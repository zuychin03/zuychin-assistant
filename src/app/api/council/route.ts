import { NextResponse } from "next/server";
import { listAwaitingOwnerCouncils, listOpenCouncils, listParticipants, type CouncilSession } from "@/lib/council/store";
import { supabaseAdmin as supabase } from "@/lib/supabase";

// Read-only: the page must never be able to advance a debate, so nothing here
// touches presence, the floor or the cursor.
export async function GET() {
    try {
        const [open, awaitingDecision] = await Promise.all([
            listOpenCouncils(),
            listAwaitingOwnerCouncils(),
        ]);

        const { data: recent } = await supabase
            .from("council_sessions")
            .select("id, code, topic, council_type, status, round, max_rounds, last_seq, last_message_at, closer_name, verdict, vault_path, archive_status, created_at, closed_at")
            .in("status", ["closed", "expired"])
            .order("created_at", { ascending: false })
            .limit(10);

        // awaiting_owner is owner-actionable, so it sorts ahead of running
        // councils. "waitingOn" is meaningless there: the wait is on the human.
        const toOpenItem = async (s: CouncilSession) => {
            const parts = await listParticipants(s.id);
            const agents = parts.filter((p) => p.kind === "agent");
            return {
                code: s.code,
                topic: s.topic,
                councilType: s.councilType,
                status: s.status,
                round: s.round,
                maxRounds: s.maxRounds,
                messages: s.lastSeq,
                lastMessageAt: s.lastMessageAt,
                closerName: s.closerName,
                expiresAt: s.expiresAt,
                waitingOn: s.status === "awaiting_owner"
                    ? []
                    : agents.filter((p) => p.status !== "left" && p.postsThisRound === 0).map((p) => p.name),
                participants: agents.map((p) => p.name),
            };
        };

        return NextResponse.json({
            open: await Promise.all([...awaitingDecision, ...open].map(toOpenItem)),
            recent: (recent ?? []).map((r) => ({
                code: r.code,
                topic: r.topic,
                councilType: r.council_type,
                status: r.status,
                round: r.round,
                maxRounds: r.max_rounds,
                messages: r.last_seq,
                closerName: r.closer_name,
                verdict: r.verdict,
                vaultPath: r.vault_path,
                archiveStatus: r.archive_status,
                closedAt: r.closed_at,
            })),
        });
    } catch (error) {
        console.error("[Council API] list failed:", error);
        return NextResponse.json({ error: "Failed to load councils." }, { status: 500 });
    }
}
