import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getDefaultProfile } from "@/lib/db";

/** GET /api/admin/status — Bot health & stats */

export async function GET() {
    try {
        const profile = await getDefaultProfile();

        // Get message counts
        const { count: totalMessages } = await supabase
            .from("messages")
            .select("*", { count: "exact", head: true });

        const { count: totalEmbeddings } = await supabase
            .from("embeddings")
            .select("*", { count: "exact", head: true });

        // Get last activity
        const { data: lastMsg } = await supabase
            .from("messages")
            .select("created_at, channel")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

        // Channel breakdown
        const { data: channelStats } = await supabase
            .from("messages")
            .select("channel");

        const channels: Record<string, number> = {};
        if (channelStats) {
            for (const row of channelStats) {
                channels[row.channel] = (channels[row.channel] || 0) + 1;
            }
        }

        return NextResponse.json({
            status: "online",
            model: "gemini-3-flash-preview",
            profile: profile
                ? { id: profile.id, displayName: profile.displayName }
                : null,
            stats: {
                totalMessages: totalMessages ?? 0,
                totalEmbeddings: totalEmbeddings ?? 0,
                lastActivity: lastMsg?.created_at ?? null,
                lastChannel: lastMsg?.channel ?? null,
                channelBreakdown: channels,
            },
            uptime: process.uptime(),
        });
    } catch (error) {
        console.error("[Admin Status] Error:", error);
        return NextResponse.json(
            { status: "error", error: "Failed to fetch status." },
            { status: 500 }
        );
    }
}
