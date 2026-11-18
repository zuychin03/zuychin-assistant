import type { MessageMetadata, ReplyRef } from "@/lib/types";

// "voice" marks a message that is the on-box transcript of a voice turn. Older clients never send it.
export type InputMode = "voice";

export function inputModeError(value: unknown): string | null {
    return value === undefined || value === "voice" ? null : "Input mode must be \"voice\" when it is set.";
}

export const VOICE_TRANSCRIPT_NOTE = "## Spoken input\nThe user spoke this message. It is an automatic speech-to-text transcript and may contain recognition errors, so answer the most likely meaning.\n\n";

export function userMessageMetadata(replyTo: ReplyRef | undefined, inputMode: InputMode | undefined): MessageMetadata | undefined {
    if (!replyTo && !inputMode) return undefined;
    return { ...(replyTo ? { replyTo } : {}), ...(inputMode ? { inputMode } : {}) };
}
