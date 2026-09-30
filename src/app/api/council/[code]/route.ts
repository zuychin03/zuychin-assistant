import { NextRequest, NextResponse } from "next/server";
import { getSessionByCode, listParticipants, readTranscript } from "@/lib/council/store";
import { getCampaignForSession, listCampaignWorkItems } from "@/lib/council/campaign";
import { readExecutionEvidence } from "@/lib/council/execution-reader";
import { parseExecutionEvidence } from "@/lib/council/execution-evidence";

const headers = { "Cache-Control": "private, no-store" };

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
        const campaign = await getCampaignForSession(session.id);
        const [participants, messages, workItems] = await Promise.all([
            listParticipants(session.id),
            readTranscript({ sessionId: session.id, fromSeq: sinceSeq, limit: 200 }),
            campaign ? listCampaignWorkItems(campaign.id) : Promise.resolve([]),
        ]);
        const executions = await readExecutionEvidence(session.id, {
            referencedIds: [...messages.map(message => message.executionId), ...workItems.flatMap(item => [item.submittedExecutionId, item.acceptedExecutionId])],
        });

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
            openObligations,
            campaign: campaign ? {
                id: campaign.id, status: campaign.status, repoPath: campaign.repoPath, baseBranch: campaign.baseBranch,
                completedAt: campaign.completedAt,
                integratorAgent: campaign.integratorAgent,
                integrationBranch: campaign.integrationBranch,
                integrationStatus: campaign.integrationStatus,
                integrationReport: null,
                integrationCheckedAt: campaign.integrationCheckedAt,
                baseSha: campaign.baseSha, verificationProfile: campaign.verificationProfile,
                integrationManifest: campaign.integrationManifest ? {
                    version: campaign.integrationManifest.version, campaignId: campaign.integrationManifest.campaignId,
                    baseSha: campaign.integrationManifest.baseSha,
                    items: campaign.integrationManifest.items.map(item => ({
                        itemId: item.itemId, sequence: item.sequence, agentName: item.agentName,
                        branch: item.branch, commitSha: item.commitSha, verificationRunId: item.verificationRunId,
                        dependencies: item.dependencies, acceptedExecutionId: item.acceptedExecutionId ?? null,
                        executionEvidence: parseExecutionEvidence(item.executionEvidence),
                    })),
                } : null, manifestFrozenAt: campaign.manifestFrozenAt,
                integrationTipSha: campaign.integrationTipSha,
                workItems: workItems.map((item) => ({
                    id: item.id, sequence: item.sequence, agentName: item.agentName, title: item.title,
                    status: item.status, heartbeatAt: item.heartbeatAt, progress: item.progress,
                    commitHash: item.commitHash, acceptedCommitSha: item.acceptedCommitSha,
                    submittedExecutionId: item.submittedExecutionId, acceptedExecutionId: item.acceptedExecutionId,
                    branchName: item.branchName, verificationProfile: item.verificationProfile,
                    verificationRunId: item.verificationRunId, dependencies: item.dependencies,
                    verification: item.verification, blockedReason: item.blockedReason,
                    hostVerified: item.hostVerified, hostVerification: null,
                })),
            } : null,
        }, { headers });
    } catch (error) {
        console.error("[Council API] detail failed:", error);
        return NextResponse.json({ error: "Failed to load council." }, { status: 500, headers });
    }
}
