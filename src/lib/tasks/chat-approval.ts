import { AsyncLocalStorage } from "node:async_hooks";
import { supabaseAdmin as db } from "@/lib/supabase";
import { canonicalAction } from "@/lib/tasks/unattended-policy";
import { mapApproval, TaskStorageError } from "@/lib/tasks/run-store";
import { sendApprovalNotice } from "@/lib/tasks/approval-notices";
import type { ActionApproval } from "@/lib/tasks/types";
import type { MessageChannel } from "@/lib/types";

/** A live chat turn whose sends wait for the owner. runRagChat opens one for every interactive turn. */
export interface ChatTurn {
    channel: MessageChannel;
    conversationId: string | null;
    turnId: string;
    instruction: string;
    userProfileId: string | null;
    /** Called once per pending approval, so the web chat can show its card. */
    onHeld?: (approval: ActionApproval) => void;
}
export interface ProposedChatAction extends Omit<ChatTurn, "onHeld"> {
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

/** The chat proposer used in production: records the action, then sends its notice. Web chat shows a card instead. */
export async function proposeChatWithNotice(action: ProposedChatAction): Promise<ActionApproval> {
    const approval = await proposeChatAction(action);
    if (approval.status === "pending" && action.channel !== "web") await sendApprovalNotice(approval);
    return approval;
}

export const NO_TURN_REFUSAL = "Sending needs the owner's approval from a chat, so nothing was sent.";

function heldText(channel: MessageChannel): string {
    const expires = `expires in ${CHAT_APPROVAL_MINUTES / 60} hour`;
    const rest = "Nothing has been sent yet.";
    const repeat = "do not call this tool again for the same action.";
    switch (channel) {
        case "web": return `Waiting for the owner's approval: an Approve card is shown under this reply (${expires}). ${rest} Tell the owner it is waiting for their approval, and ${repeat}`;
        case "discord": return `Waiting for the owner's approval in Telegram or on the Tasks page (${expires}). ${rest} Tell the owner where to approve it, and ${repeat}`;
        default: return `Waiting for the owner's approval in Telegram (buttons sent; ${expires}). ${rest} Tell the owner it is waiting for their tap, and ${repeat}`;
    }
}

/** Null lets the tool run. Otherwise the text the model gets instead of a result; nothing was sent. */
export async function gateChatSend(tool: string, args: Record<string, unknown>, propose: ChatProposer = proposeChatWithNotice): Promise<string | null> {
    if (!chatSendNeedsApproval(tool, args)) return null;
    const turn = scope.getStore();
    // Fails closed: approved actions and scheduled runs pass under their permit before this gate.
    if (!turn) {
        console.warn(`[ChatApproval] Refused ${tool} outside a chat turn.`);
        return NO_TURN_REFUSAL;
    }
    if (!turn.userProfileId) return "This chat has no confirmed owner, so the action was not sent.";
    try {
        const action = canonicalAction(tool, args);
        const { onHeld, ...identity } = turn;
        const approval = await propose({ ...identity, tool, args: action.args, argsHash: action.hash });
        if (approval.status !== "pending") return `This action is already recorded as ${approval.status.replaceAll("_", " ")}. It was not repeated.`;
        onHeld?.(approval);
        return heldText(turn.channel);
    } catch (error) {
        console.warn("[ChatApproval] Could not record the approval:", error instanceof Error ? error.message : error);
        return "The approval could not be recorded safely, so the action was not sent. Tell the owner and suggest trying again later.";
    }
}
