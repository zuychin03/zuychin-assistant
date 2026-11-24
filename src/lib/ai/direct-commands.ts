import type { ResolvedEmbedding } from "@/lib/ai/embeddings";
import type { ResolvedChat } from "@/lib/ai/providers";
import type { SingleTurn } from "@/lib/ai/models/consult";
import { gatherBriefFacts, writeBrief, type BriefSources } from "@/lib/ai/brief";
import { findLanguage, translateText, translationCredit, TRANSLATE_MAX_CHARS, TRANSLATE_USAGE, type TranslateDeps } from "@/lib/ai/translate";
import type { ReplyRef } from "@/lib/types";

// /brief and /translate (V8 F8, F9) answer the same way on every channel and skip the retrieval and tool path.

export type DirectCommand = { kind: "brief"; study: boolean } | { kind: "translate"; language: string; text: string };

const DIRECT = /^[/!](brief|translate)(?:@\S+)?(?=\s|$)\s*([\s\S]*)$/i;

export function parseDirectCommand(message: string): DirectCommand | null {
    const match = DIRECT.exec(message.trim());
    if (!match) return null;
    const rest = match[2].trim();
    if (match[1].toLowerCase() === "brief") return { kind: "brief", study: /^study\b/i.test(rest) };
    const parts = /^(?:(?:to|into)\s+)?(\S+)\s*([\s\S]*)$/i.exec(rest);
    return { kind: "translate", language: parts?.[1] ?? "", text: parts?.[2].trim() ?? "" };
}

export interface DirectContext {
    chat: ResolvedChat;
    embRef: ResolvedEmbedding;
    freeOnly: boolean;
    /** The message a /translate replies to; its text is translated when the command carries none. */
    replyTo?: ReplyRef;
    signal?: AbortSignal;
    briefSources(): BriefSources;
    translateDeps(chat: ResolvedChat, embRef: ResolvedEmbedding): TranslateDeps;
    /** The briefing's model call; tests pass a fake. */
    generate?: (chat: ResolvedChat, turn: SingleTurn) => Promise<string>;
}

/** `speak` asks the channel to read the reply aloud whatever the saved voice preference says. */
export async function runDirectCommand(command: DirectCommand, ctx: DirectContext): Promise<{ reply: string; speak: boolean }> {
    if (command.kind === "brief") {
        const facts = await gatherBriefFacts(ctx.briefSources(), { study: command.study });
        ctx.signal?.throwIfAborted();
        const { script } = await writeBrief({ chat: ctx.chat, embRef: ctx.embRef, study: command.study, facts, signal: ctx.signal }, ctx.generate);
        return { reply: script, speak: true };
    }
    const target = findLanguage(command.language);
    if (!target) return { reply: command.language ? `I don't know the language "${command.language.slice(0, 40)}". ${TRANSLATE_USAGE}` : TRANSLATE_USAGE, speak: false };
    const text = command.text || ctx.replyTo?.content.trim() || "";
    if (!text) return { reply: `There is nothing to translate. ${TRANSLATE_USAGE}`, speak: false };
    if (text.length > TRANSLATE_MAX_CHARS) {
        return { reply: `That is too long to translate here (${text.length.toLocaleString("en-AU")} characters; the limit is ${TRANSLATE_MAX_CHARS.toLocaleString("en-AU")}). Send it in parts.`, speak: false };
    }
    const translation = await translateText(text, target, { freeOnly: ctx.freeOnly, signal: ctx.signal }, ctx.translateDeps(ctx.chat, ctx.embRef));
    return { reply: `${translation.text}\n\n_${translationCredit(translation)}_`, speak: false };
}
