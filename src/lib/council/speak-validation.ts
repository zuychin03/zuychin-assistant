import { INTENTS_REQUIRING_REPLY_TO, INTENTS_REQUIRING_TARGET, type CouncilIntent } from "./protocol";

export class CouncilSpeakProtocolError extends Error {
    constructor(readonly code: "invalid_target" | "target_required" | "reply_required", detail: string, next: string) {
        super(`PROTOCOL_ERROR - nothing was recorded.\n${detail}\n\nNEXT → repeat your council_speak call ${next}.`);
        this.name = "CouncilSpeakProtocolError";
    }
}

export function validateSpeakMessage(params: { intent: string; addressedTo?: string; replyToSeq?: number }, roster: readonly { name: string }[]): void {
    const target = params.addressedTo ?? "all";
    const validTargets = [...roster.map(participant => participant.name), "all"];
    if (!validTargets.includes(target)) throw new CouncilSpeakProtocolError("invalid_target", `addressedTo "${target}" is not on the roster. Valid values: ${validTargets.join(", ")}.`, "with a valid addressedTo");
    if (INTENTS_REQUIRING_TARGET.includes(params.intent as CouncilIntent) && target === "all") throw new CouncilSpeakProtocolError("target_required", `intent "${params.intent}" must name one participant in addressedTo. Valid values: ${validTargets.filter(name => name !== "all").join(", ")}.`, "with addressedTo set");
    if (INTENTS_REQUIRING_REPLY_TO.includes(params.intent as CouncilIntent) && params.replyToSeq == null) throw new CouncilSpeakProtocolError("reply_required", `intent "${params.intent}" must set replyToSeq to the seq you are responding to; that is what clears the obligation.`, "with replyToSeq set");
}
