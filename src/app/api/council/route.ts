import { NextResponse } from "next/server";
import { listAwaitingOwnerCouncils, listCampaignCouncils, listOpenCouncils, listParticipants, type CouncilSession } from "@/lib/council/store";
import { supabaseAdmin as supabase } from "@/lib/supabase";

// Read-only: the page must never be able to advance a debate, so nothing here
// touches presence, the floor or the cursor.
export async function GET() {
    try {
        const [open, awaitingDecision, campaigns] = await Promise.all([
            listOpenCouncils(),
            listAwaitingOwnerCouncils(),
            listCampaignCouncils(),
        ]);

        // A Council with work still running is closed, so it would otherwise
        // appear in both lists at once. It belongs in the live one: the campaign
        // is the part a host can still be handed back.
        const liveCampaigns = new Set(campaigns.map((s) => s.id));
        let archive = supabase
            .from("council_sessions")
            .select("id, code, topic, council_type, status, round, max_rounds, last_seq, last_message_at, closer_name, verdict, vault_path, archive_status, created_at, closed_at")
            .in("status", ["closed", "expired"]);
        if (liveCampaigns.size) archive = archive.not("id", "in", `(${[...liveCampaigns].join(",")})`);
        const { data: recent } = await archive.order("created_at", { ascending: false }).limit(10);

        // awaiting_owner is owner-actionable, so it sorts ahead of running
        // councils. "waitingOn" is meaningless there: the wait is on the human.
        // It is meaningless for a campaign too, where rounds are over.
        const toOpenItem = async (s: CouncilSession) => {
            const parts = await listParticipants(s.id);
            const agents = parts.filter((p) => p.kind === "agent");
            return {
                code: s.code,
                topic: s.topic,
                councilType: s.councilType,
                status: s.status,
                campaignRunning: liveCampaigns.has(s.id),
                round: s.round,
                maxRounds: s.maxRounds,
                messages: s.lastSeq,
                lastMessageAt: s.lastMessageAt,
                closerName: s.closerName,
                expiresAt: s.expiresAt,
                waitingOn: s.status === "awaiting_owner" || liveCampaigns.has(s.id)
                    ? []
                    : agents.filter((p) => p.status !== "left" && p.postsThisRound === 0).map((p) => p.name),
                participants: agents.map((p) => p.name),
            };
        };

        return NextResponse.json({
            open: await Promise.all([...awaitingDecision, ...campaigns, ...open].map(toOpenItem)),
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
