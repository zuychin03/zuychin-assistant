import { AsyncLocalStorage } from "node:async_hooks";
import { supabaseAdmin as db } from "@/lib/supabase";
import { canonicalAction } from "@/lib/tasks/unattended-policy";
import { mapApproval, TaskStorageError } from "@/lib/tasks/run-store";
import { sendApprovalNotice } from "@/lib/tasks/approval-notices";
import type { ActionApproval } from "@/lib/tasks/types";

/** A live chat turn whose sends wait for the owner. Only the Telegram webhook opens one. */
export interface ChatTurn {
    channel: "telegram";
    conversationId: string | null;
    turnId: string;
    instruction: string;
    userProfileId: string | null;
}
export interface ProposedChatAction extends ChatTurn {
    tool: string; args: Record<string, unknown>; argsHash: string;
}
export type ChatProposer = (action: ProposedChatAction) => Promise<ActionApproval>;

const scope = new AsyncLocalStorage<ChatTurn>();
export const CHAT_APPROVAL_MINUTES = 60;

export function withChatApprovals<T>(turn: ChatTurn, fn: () => T): T {
    return scope.run(turn, fn);
}

export function inChatApprovalTurn(): boolean { return Boolean(scope.getStore()); }

/** Sends leave the app: email, and calendar changes. Reads, drafts and in-app writes run as before. */
export function chatSendNeedsApproval(tool: string, args: Record<string, unknown>): boolean {
    if (tool === "send_email") return true;
    return tool === "manage_calendar_event" && !["list", "get"].includes(String(args.action ?? ""));
}

export async function proposeChatAction(action: ProposedChatAction): Promise<ActionApproval> {
    const { data, error } = await db.rpc("assistant_propose_chat_action", {
        p_profile: action.userProfileId, p_conversation: action.conversationId, p_turn: action.turnId, p_channel: action.channel,
        p_tool: action.tool, p_args: action.args, p_hash: action.argsHash, p_instruction: action.instruction, p_sources: "",
    }).abortSignal(AbortSignal.timeout(5000));
    if (error || !data?.id) throw new TaskStorageError("Chat approval storage unavailable.");
    return mapApproval(data);
}

/** The chat proposer used in production: records the action, then sends its Telegram buttons. */
export async function proposeChatWithNotice(action: ProposedChatAction): Promise<ActionApproval> {
    const approval = await proposeChatAction(action);
    if (approval.status === "pending") await sendApprovalNotice(approval);
    return approval;
}

/** Null lets the tool run. Otherwise the text the model gets instead of a result; nothing was sent. */
export async function gateChatSend(tool: string, args: Record<string, unknown>, propose: ChatProposer = proposeChatWithNotice): Promise<string | null> {
    const turn = scope.getStore();
    if (!turn || !chatSendNeedsApproval(tool, args)) return null;
    if (!turn.userProfileId) return "This chat has no confirmed owner, so the action was not sent.";
    try {
        const action = canonicalAction(tool, args);
        const approval = await propose({ ...turn, tool, args: action.args, argsHash: action.hash });
        return approval.status === "pending"
            ? `Waiting for the owner's approval in Telegram (buttons sent; expires in ${CHAT_APPROVAL_MINUTES / 60} hour). Nothing has been sent yet. Tell the owner it is waiting for their tap, and do not call this tool again for the same action.`
            : `This action is already recorded as ${approval.status.replaceAll("_", " ")}. It was not repeated.`;
    } catch (error) {
        console.warn("[ChatApproval] Could not record the approval:", error instanceof Error ? error.message : error);
        return "The approval could not be recorded safely, so the action was not sent. Tell the owner and suggest trying again later.";
    }
}
