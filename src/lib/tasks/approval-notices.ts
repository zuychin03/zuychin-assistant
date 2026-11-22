import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { APP_TIMEZONE } from "@/lib/datetime";
import { notify } from "@/lib/messaging/router";
import { editTelegramMessageText } from "@/lib/messaging/telegram-service";
import { isLoopbackUrl, ownerLink } from "@/lib/public-url";
import { proposeAction } from "@/lib/tasks/run-store";
import type { ProposedAction } from "@/lib/tasks/unattended-policy";
import type { ActionApproval } from "@/lib/tasks/types";

type Notice = Pick<ActionApproval, "id" | "taskTitle" | "tool" | "args" | "expiresAt" | "status" | "receipt">;

const MISSING = new Set(["PGRST205", "42P01"]);
let warnedMissing = false;

const TOOL_LABELS: Record<string, string> = {
    send_email: "Send an email",
    draft_gmail_reply: "Draft a Gmail reply",
    manage_calendar_event: "Change the calendar",
    save_note: "Save a note",
    capture_add: "Add to Capture",
    vault_write: "Write a vault page",
    vault_ingest: "Add a source to the vault",
    vault_delete: "Delete a vault page",
    vault_lint: "Tidy the vault",
    manage_todo_list: "Change the to-do list",
    manage_notes: "Change a note",
    manage_memory_facts: "Change a remembered fact",
    manage_scheduled_task: "Change a scheduled task",
};
const FIRST_KEYS = ["action", "to", "cc", "subject", "summary", "title", "start", "end", "event_id", "path"];
const LONG_KEYS = new Set(["body", "content", "markdown", "description", "text", "instruction"]);
const MAX_ARGUMENT_LINES = 8;

export const APPROVAL_CALLBACK = /^apr:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(a|r)$/;

function clip(text: string, limit: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function approvalArgumentLines(args: Record<string, unknown>): string[] {
    const keys = Object.keys(args).filter((key) => args[key] !== null && args[key] !== undefined && args[key] !== "");
    keys.sort((a, b) => (FIRST_KEYS.indexOf(a) + 1 || 99) - (FIRST_KEYS.indexOf(b) + 1 || 99));
    const lines = keys.slice(0, MAX_ARGUMENT_LINES).map((key) => {
        const value = args[key];
        const text = typeof value === "string" ? value : JSON.stringify(value);
        const name = key.charAt(0).toUpperCase() + key.slice(1).replaceAll("_", " ");
        return `${name}: ${clip(text, LONG_KEYS.has(key) ? 600 : 160)}`;
    });
    if (keys.length > MAX_ARGUMENT_LINES) lines.push(`(${keys.length - MAX_ARGUMENT_LINES} more in Tasks)`);
    return lines;
}

function expiry(iso: string): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "unknown";
    // ICU puts a narrow no-break space before "am"; a plain space reads the same everywhere.
    return new Intl.DateTimeFormat("en-AU", {
        timeZone: APP_TIMEZONE, day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(date).replace(/ /g, " ");
}

export function approvalActionLabel(tool: string): string {
    return TOOL_LABELS[tool] ?? tool;
}

/** Plain text: argument values are shown exactly, never read as Markdown. */
export function approvalNoticeText(approval: Notice): string {
    return [
        "🔐 Approval needed",
        `From: ${approval.taskTitle}`,
        "",
        approvalActionLabel(approval.tool),
        ...approvalArgumentLines(approval.args),
        "",
        `Expires ${expiry(approval.expiresAt)}.`,
    ].join("\n");
}

/** The line added once the approval is settled; null while it is still pending or running. */
export function approvalOutcomeLine(approval: Pick<ActionApproval, "status" | "receipt">): string | null {
    switch (approval.status) {
        case "succeeded": return `✅ Approved and done.${approval.receipt ? `\n${clip(approval.receipt, 500)}` : ""}`;
        case "outcome_unknown": return "⚠️ Approved, but the outcome is unknown. Check the destination before trying again.";
        case "rejected": return "❌ Rejected. Nothing was run.";
        case "expired": return "⌛ Expired. Nothing was run.";
        default: return null;
    }
}

export function approvalReviewLink(id: string): string {
    return ownerLink(`/tasks?approval=${id}`);
}

// Telegram refuses the whole message when a URL button is not a public https address.
export function approvalKeyboard(id: string) {
    const review = approvalReviewLink(id);
    const open = /^https:\/\//.test(review) && !isLoopbackUrl(review) ? [[{ text: "Open", url: review }]] : [];
    return { inline_keyboard: [[{ text: "Approve", callback_data: `apr:${id}:a` }, { text: "Reject", callback_data: `apr:${id}:r` }], ...open] };
}

function noticesMissing(error: { code?: string; message?: string }): boolean {
    if (!MISSING.has(error.code ?? "")) return false;
    if (!warnedMissing) {
        warnedMissing = true;
        console.warn("[Approvals] assistant_approval_notices is missing; apply scripts/migrations/v7-channel-threads.sql. Approvals are listed in Tasks only.");
    }
    return true;
}

/** Sends one notice per approval and channel; a repeat proposal of the same action sends nothing. Never throws. */
export async function sendApprovalNotice(approval: Notice, client: SupabaseClient = supabaseAdmin): Promise<void> {
    try {
        const telegram = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
        const channel = telegram ? "telegram" : "discord";
        const chatId = telegram ? process.env.TELEGRAM_CHAT_ID! : "tasks";
        const { data, error } = await client.from("assistant_approval_notices")
            .upsert({ approval_id: approval.id, channel, chat_id: chatId }, { onConflict: "approval_id,channel", ignoreDuplicates: true })
            .select("approval_id");
        if (error) {
            if (!noticesMissing(error)) console.warn("[Approvals] Could not record the notice:", error.message);
            return;
        }
        if (!data?.length) return;

        const text = telegram ? approvalNoticeText(approval) : `${approvalNoticeText(approval)}\nReview it: ${approvalReviewLink(approval.id)}`;
        const sent = await notify("action_approval", text, telegram ? { telegramReplyMarkup: approvalKeyboard(approval.id), telegramPlain: true } : {});
        if (sent.telegramMessageId !== null) {
            const { error: saveError } = await client.from("assistant_approval_notices")
                .update({ message_id: sent.telegramMessageId }).eq("approval_id", approval.id).eq("channel", "telegram");
            if (saveError) console.warn("[Approvals] The notice was sent but its message id was not saved:", saveError.message);
        } else if (!sent.telegram && !sent.discord) {
            // Nothing went out, so a later proposal of the same action may try again.
            await client.from("assistant_approval_notices").delete().eq("approval_id", approval.id).eq("channel", channel);
        }
    } catch (error) {
        console.warn("[Approvals] Notice failed:", error instanceof Error ? error.message : error);
    }
}

/** Edits the Telegram notice once the approval is settled, removing its buttons. Never throws. */
export async function settleApprovalNotice(approval: Notice, client: SupabaseClient = supabaseAdmin): Promise<void> {
    const outcome = approvalOutcomeLine(approval);
    if (!outcome || !process.env.TELEGRAM_BOT_TOKEN) return;
    try {
        const { data, error } = await client.from("assistant_approval_notices")
            .select("chat_id, message_id").eq("approval_id", approval.id).eq("channel", "telegram").not("message_id", "is", null);
        if (error) {
            if (!noticesMissing(error)) console.warn("[Approvals] Could not read the notice:", error.message);
            return;
        }
        const text = `${approvalNoticeText(approval)}\n\n${outcome}`;
        for (const row of data ?? []) await editTelegramMessageText(String(row.chat_id), Number(row.message_id), text);
    } catch (error) {
        console.warn("[Approvals] Notice edit failed:", error instanceof Error ? error.message : error);
    }
}

/** The unattended gate's proposer: records the action, then sends its notice. */
export async function proposeWithNotice(action: ProposedAction): Promise<{ id: string; status: string }> {
    const proposal = await proposeAction(action);
    if (proposal.status === "pending") await sendApprovalNotice(proposal.approval);
    return proposal;
}
