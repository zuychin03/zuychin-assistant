import { canOwnCouncil } from "@/lib/agents/scopes";
import type { CouncilCaller } from "@/lib/council/host-contracts";
import { MAX_OPEN_COUNCILS, MODERATOR_NAME } from "@/lib/council/protocol";
import { createCouncilSession, listOpenCouncils, listParticipants, type CouncilSession } from "@/lib/council/store";
import { getCouncilTemplate } from "@/lib/council/templates";

// Councils open here and nowhere else, so every rule on who may convene and
// what roster is valid lives in one place.

export type ConveneRejection =
    | { reason: "participant_count"; count: number }
    | { reason: "closer_not_participant"; names: string[] }
    | { reason: "duplicate_names"; names: string[] }
    | { reason: "reserved_name"; name: string }
    | { reason: "council_type"; councilType: string }
    | { reason: "open_limit"; open: CouncilSession[] };

// The roster is closed at convene time, so these are the only checks that stop
// a typo from creating a phantom participant or an unclosable Council.
export function conveneRejection(participants: { name: string }[], closerName: string): ConveneRejection | null {
    const names = participants.map((p) => p.name);
    if (participants.length < 2 || participants.length > 5) return { reason: "participant_count", count: participants.length };
    if (!names.includes(closerName)) return { reason: "closer_not_participant", names };
    if (new Set(names).size !== names.length) return { reason: "duplicate_names", names };
    if (names.includes(MODERATOR_NAME)) return { reason: "reserved_name", name: MODERATOR_NAME };
    return null;
}

export async function conveneCouncil(
    params: {
        topic: string; brief: string; participants: { name: string; expertise: string }[]; closerName: string;
        councilType?: string; maxRounds?: number; maxMessages?: number; ttlMinutes?: number;
    },
    caller: CouncilCaller | undefined,
) {
    if (!canOwnCouncil(caller?.scopes)) {
        return { kind: "denied" as const, message: "This tool requires an owner or Council host credential." };
    }
    // Only online debates run now; code, research, audit and debug councils needed the retired local host.
    const councilType = params.councilType ?? "debate";
    if (councilType !== "debate") return { kind: "rejected" as const, rejection: { reason: "council_type" as const, councilType } };
    const rejection = conveneRejection(params.participants, params.closerName);
    if (rejection) return { kind: "rejected" as const, rejection };
    const open = await listOpenCouncils();
    if (open.length >= MAX_OPEN_COUNCILS) return { kind: "rejected" as const, rejection: { reason: "open_limit" as const, open } };

    const template = getCouncilTemplate(councilType);
    const session = await createCouncilSession({
        topic: params.topic, brief: params.brief, closerName: params.closerName, participants: params.participants,
        councilType,
        maxRounds: params.maxRounds ?? template.defaults.maxRounds,
        maxMessages: params.maxMessages ?? template.defaults.maxMessages,
        ttlMinutes: params.ttlMinutes ?? template.defaults.ttlMinutes,
    });
    return { kind: "convened" as const, session, roster: await listParticipants(session.id) };
}
