import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getDefaultProfile } from "@/lib/db";
import { DEFAULT_CHAT } from "@/lib/ai/providers";

export async function GET() {
    try {
        const profile = await getDefaultProfile();

        const [
            { count: totalMessages },
            { count: totalEmbeddings },
            { count: totalConversations },
            { count: totalTodos },
            { count: pendingTodos },
            { count: totalArtifacts },
            { count: totalVaultPages },
        ] = await Promise.all([
            supabase.from("messages").select("*", { count: "exact", head: true }),
            supabase.from("embeddings").select("*", { count: "exact", head: true }),
            supabase.from("conversations").select("*", { count: "exact", head: true }),
            supabase.from("todos").select("*", { count: "exact", head: true }),
            supabase.from("todos").select("*", { count: "exact", head: true }).eq("status", "pending"),
            supabase.from("artifacts").select("*", { count: "exact", head: true }),
            supabase.from("vault_pages").select("*", { count: "exact", head: true }),
        ]);

        const { data: lastMsg } = await supabase
            .from("messages")
            .select("created_at, channel")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

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
            model: DEFAULT_CHAT.modelId,
            profile: profile
                ? { id: profile.id, displayName: profile.displayName, systemPrompt: profile.systemPrompt }
                : null,
            stats: {
                totalMessages: totalMessages ?? 0,
                totalEmbeddings: totalEmbeddings ?? 0,
                totalConversations: totalConversations ?? 0,
                totalTodos: totalTodos ?? 0,
                pendingTodos: pendingTodos ?? 0,
                totalArtifacts: totalArtifacts ?? 0,
                totalVaultPages: totalVaultPages ?? 0,
                lastActivity: lastMsg?.created_at ?? null,
                lastChannel: lastMsg?.channel ?? null,
                channelBreakdown: channels,
            },
            integrations: {
                google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN),
                discord: !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID),
                telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
                vault: !!(process.env.GITHUB_VAULT_REPO && process.env.GITHUB_VAULT_TOKEN),
                tavily: !!process.env.TAVILY_API_KEY,
                cron: !!process.env.CRON_SECRET,
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
