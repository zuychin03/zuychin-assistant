import { getDefaultProfile } from "@/lib/db";
import { effectiveFreeOnly } from "@/lib/ai/model-policy";
import { briefingVoicePlan, FULL_TTS_CHARS, observeSpeech, replyVoicePlan, synthesizeSpeech } from "@/lib/ai/tts";
import { readVoiceChoices } from "@/lib/ai/voice-choices";

// The Discord bot attaches files up to this size and skips larger ones.
export const MAX_DISCORD_FILE_BYTES = 8 * 1024 * 1024;

// A transcribed voice message is an audio turn, as on Telegram; otherwise a spoken reply goes out only when the
// saved preference is "always". The bot already attaches every artifact with data, so the speech rides along as
// reply.wav. A /brief reply always speaks, at full length. Best effort: a failure never costs the text reply.
export async function discordSpeechAttachment(reply: string, requestedFreeOnly: boolean, signal?: AbortSignal, audioTurn = false, briefing = false) {
    if (!reply.trim()) return null;
    try {
        const [profile] = await Promise.all([getDefaultProfile(), readVoiceChoices()]);
        const freeOnly = effectiveFreeOnly(profile, requestedFreeOnly);
        const plan = briefing ? briefingVoicePlan(profile?.preferences) : replyVoicePlan(profile?.preferences, { audioTurn, freeOnly });
        if (!plan) return null;
        const { buffer } = await observeSpeech(profile?.id, () => synthesizeSpeech(reply, plan, signal, briefing ? FULL_TTS_CHARS : undefined), briefing);
        if (buffer.length > MAX_DISCORD_FILE_BYTES) return null;
        return { id: "spoken-reply", name: "reply.wav", mime: "audio/wav", kind: "document" as const, size: buffer.length, base64: buffer.toString("base64") };
    } catch {
        console.warn("[Chat] Spoken Discord reply skipped.");
        return null;
    }
}
