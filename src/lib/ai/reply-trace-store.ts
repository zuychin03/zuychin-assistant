import { supabaseAdmin } from "@/lib/supabase";
import { persistModelObservations } from "@/lib/ai/model-health";
import { mergeReplyTrace, type ReplyTrace } from "@/lib/ai/reply-trace";
import type { MessageMetadata } from "@/lib/types";

export async function saveReplyTrace(messageId: string, incoming: ReplyTrace, conversationId?: string): Promise<ReplyTrace> {
    let trace = incoming;
    let userProfileId: string | undefined;
    const signal = AbortSignal.timeout(2000);
    try {
        if (messageId) for (let attempt = 0; attempt < 3; attempt++) {
            const { data, error } = await supabaseAdmin.from("messages").select("metadata,user_profile_id").eq("id", messageId).eq("role", "assistant").abortSignal(signal).maybeSingle();
            if (error || !data) break;
            userProfileId = data.user_profile_id ?? undefined;
            const previous = (data.metadata ?? {}) as MessageMetadata;
            trace = mergeReplyTrace(previous.replyTrace as ReplyTrace | undefined, incoming);
            const written = await supabaseAdmin.rpc("assistant_reply_trace_save", {
                p_message_id: messageId, p_expected_trace: previous.replyTrace ?? null, p_trace: trace,
            }).abortSignal(signal);
            if (written.error) break;
            if (written.data === true) {
                await persistModelObservations(incoming.calls, { messageId, conversationId, userProfileId });
                return trace;
            }
        }
    } catch { /* Reply delivery does not depend on telemetry storage. */ }
    await persistModelObservations(incoming.calls, { messageId, conversationId, userProfileId });
    return { ...trace, saved: false };
}
