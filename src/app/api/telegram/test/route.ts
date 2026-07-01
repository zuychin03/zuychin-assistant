import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
    const results: Record<string, string> = {};

    results.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ? "✅ set" : "❌ missing";
    results.TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ? "✅ set" : "⚠️ not set (ok if intentional)";
    results.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ? "✅ set" : "❌ missing";
    results.SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "✅ set" : "❌ missing";
    results.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ? "✅ set" : "❌ missing - DB writes will fail on server-side routes!";
    results.GEMINI_API_KEY = process.env.GEMINI_API_KEY ? "✅ set" : "❌ missing";

    try {
        const { error } = await supabaseAdmin
            .from("messages")
            .insert({
                role: "system",
                content: "[diagnostic test - safe to delete]",
                channel: "telegram",
            })
            .select("id")
            .single();

        if (error) {
            results.supabase_write = `❌ FAILED: ${error.message} (code: ${error.code})`;
        } else {
            results.supabase_write = "✅ Supabase write OK";
        }
    } catch (e) {
        results.supabase_write = `❌ Exception: ${String(e)}`;
    }

    try {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) {
            results.telegram_bot = "❌ No token";
        } else {
            const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
            const data = await res.json();
            if (data.ok) {
                results.telegram_bot = `✅ Bot: @${data.result.username} (${data.result.first_name})`;
            } else {
                results.telegram_bot = `❌ Telegram API error: ${data.description}`;
            }
        }
    } catch (e) {
        results.telegram_bot = `❌ Exception: ${String(e)}`;
    }

    try {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) {
            const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
            const data = await res.json();
            if (data.ok) {
                const info = data.result;
                results.webhook_url = info.url ? `✅ ${info.url}` : "❌ No webhook set";
                results.webhook_pending = `${info.pending_update_count ?? 0} pending updates`;
                results.webhook_last_error = info.last_error_message ?? "none";
            }
        }
    } catch (e) {
        results.webhook_info = `❌ Exception: ${String(e)}`;
    }

    return NextResponse.json(results, { status: 200 });
}
