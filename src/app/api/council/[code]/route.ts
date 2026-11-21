import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode, listParticipants, readTranscript, type CouncilParticipant, type CouncilSession } from "@/lib/council/store";
import { readExecutionEvidence } from "@/lib/council/execution-reader";
import { latestSeatModels, readLease } from "@/lib/council/online/store";
import { resolveModelKey } from "@/lib/ai/providers";

const headers = { "Cache-Control": "private, no-store" };

// Online councils are debates whose every seat is a managed_api model run.
async function readOnlineState(session: CouncilSession, participants: CouncilParticipant[]) {
    if (session.protocolVersion !== 3 || session.councilType !== "debate") return null;
    const agents = participants.filter((p) => p.kind === "agent");
    const models = await latestSeatModels(session.id).catch(() => new Map());
    if (agents.length === 0 || agents.some((p) => !models.has(p.name))) return null;
    const lease = ["open", "concluding"].includes(session.status) ? await readLease(session.id) : null;
    const state = session.status === "awaiting_owner" ? "waiting_owner"
        : !["open", "concluding"].includes(session.status) ? "ended"
            : session.pausedAt ? "paused"
                : lease?.live ? "running" : "restarting";
    return {
        seats: agents.map((p) => {
            const key: string = models.get(p.name)!.modelKey;
            const resolved = resolveModelKey(key);
            return { name: p.name, modelKey: key, label: resolved?.model.label ?? key, available: resolved !== null };
        }),
        runner: { state, leaseExpiresAt: lease?.leaseExpiresAt ?? null },
    };
}

// Polled every couple of seconds by /council, so it stays a plain read: no
// touch, no election, no cursor write. Watching must never change whose turn it
// is.
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
    try {
        const { code } = await params;
        const session = await getSessionByCode(code);
        if (!session) {
            return NextResponse.json({ error: "No council with that code." }, { status: 404, headers });
        }

        const sinceSeq = Number(req.nextUrl.searchParams.get("sinceSeq") ?? 0);
        const [participants, messages] = await Promise.all([
            listParticipants(session.id),
            readTranscript({ sessionId: session.id, fromSeq: sinceSeq, limit: 200 }),
        ]);
        const [executions, online] = await Promise.all([
            readExecutionEvidence(session.id, { referencedIds: messages.map(message => message.executionId) }),
            readOnlineState(session, participants),
        ]);

        // Obligations are already machine-computed by the protocol, so the page
        // reads them rather than re-deriving what "unanswered" means.
        const openObligations = messages
            .filter((m) => !m.answered && ["challenge", "ask"].includes(m.intent) && m.addressedTo !== "all")
            .map((m) => ({ seq: m.seq, from: m.speaker, to: m.addressedTo, intent: m.intent }));

        return NextResponse.json({
            session: {
                code: session.code,
                topic: session.topic,
                councilType: session.councilType,
                brief: session.brief,
                status: session.status,
                round: session.round,
                maxRounds: session.maxRounds,
                messages: session.lastSeq,
                closerName: session.closerName,
                lastMessageAt: session.lastMessageAt,
                expiresAt: session.expiresAt,
                verdict: session.verdict,
                openQuestions: session.openQuestions,
                vaultPath: session.vaultPath,
                archiveStatus: session.archiveStatus,
                floorHolder: session.floorHolder,
                paused: session.pausedAt !== null && ["open", "concluding"].includes(session.status),
                pausedAt: session.pausedAt,
                standbyExpiresAt: session.standbyExpiresAt,
                continueCount: session.continueCount,
                protocolVersion: session.protocolVersion,
                baseSha: session.baseSha,
            },
            participants: participants.map((p) => ({
                name: p.name,
                kind: p.kind,
                expertise: p.expertise,
                status: p.status,
                postsTotal: p.postsTotal,
                postsThisRound: p.postsThisRound,
                lastSeenAt: p.lastSeenAt,
            })),
            messages,
            executions,
            online,
            openObligations,
        }, { headers });
    } catch (error) {
        console.error("[Council API] detail failed:", error);
        return NextResponse.json({ error: "Failed to load council." }, { status: 500, headers });
    }
}
