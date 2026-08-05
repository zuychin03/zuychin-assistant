import { NextRequest, NextResponse } from "next/server";
import { notify } from "@/lib/messaging/router";
import { finalizeCouncil, proposeCouncilVerdict } from "@/lib/council/close";
import { requireCron } from "@/lib/auth/guard";
import {
    expireOverdueSessions, listStandbyExpired, listUnfiledArchives, listSessionsNeedingVerdict,
    readTranscript,
} from "@/lib/council/store";

export const maxDuration = 60;

// A terminal session gets this long for its own closer to write the verdict
// before the sweep writes one from the transcript.
const VERDICT_GRACE_MS = 10 * 60 * 1000;
// How long a 'pending' archive may sit before it is treated as abandoned. Long
// enough that a close still in flight is never fought over.
const ARCHIVE_GRACE_MS = 10 * 60 * 1000;

// The only actor when EVERY participant is dead and nobody is polling to execute
// a transition. Expires overdue sessions, writes an auto-verdict for terminal
// sessions nobody concluded, and retries filing that failed at close time.
export async function POST(req: NextRequest) {
    try {
        const denied = requireCron(req);
        if (denied) return denied;

        const expired = await expireOverdueSessions();

        let autoVerdicts = 0;
        for (const session of await listSessionsNeedingVerdict(VERDICT_GRACE_MS)) {
            const messages = await readTranscript({ sessionId: session.id, limit: 200 });
            const speakers = [...new Set(messages.filter((m) => m.role === "agent").map((m) => m.speaker))];
            const verdict = messages.length
                ? `No verdict was written before this council ended. Auto-summary: ${speakers.length} participant(s) `
                  + `(${speakers.join(", ")}) exchanged ${messages.length} messages over ${session.round} round(s) on "${session.topic}". `
                  + `The closer (${session.closerName}) did not conclude. Read the transcript before relying on anything here.`
                : `This council ended without a single message. Nothing was decided.`;
            // Proposed, not filed: an abandoned council still gets the owner's
            // decision, and the standby TTL below accepts it if he never rules.
            const outcome = await proposeCouncilVerdict({
                session, closer: "zuychin", verdict, openQuestions: [],
            });
            if (outcome.changed) autoVerdicts++;
            await notify(
                "council_stalled",
                `**Council ${session.code} ended without a verdict** - ${session.topic}\n`
                + `${messages.length} messages, ${session.round} round(s). An auto-summary is waiting on your`
                + ` decision in /council; it files itself if you do not get to it.`,
            ).catch((e) => console.warn("[CouncilSweep] notify failed:", e));
        }

        // Standby that ran out. Accepting rather than discarding: the verdict
        // already exists, and binning finished work to tidy up is the worse
        // failure. He is told it happened without him.
        let autoAccepted = 0;
        for (const session of await listStandbyExpired()) {
            const outcome = await finalizeCouncil(session);
            if (!outcome.changed) continue;
            autoAccepted++;
            await notify(
                "council_stalled",
                `**Council ${session.code} filed itself** - ${session.topic}\n`
                + `It waited ${Math.round((Date.now() - Date.parse(session.verdictProposedAt ?? session.lastMessageAt)) / 3600_000)}h`
                + ` for your decision, so the verdict was accepted as written`
                + (outcome.vaultPath ? `: ${outcome.vaultPath}` : " (vault write failed)"),
            ).catch((e) => console.warn("[CouncilSweep] notify failed:", e));
        }

        // Every row here is already status='closed', so the conclude CAS would
        // always refuse: file directly rather than routing back through
        // closeCouncil for a result that is known in advance.
        let refiled = 0;
        for (const session of await listUnfiledArchives(ARCHIVE_GRACE_MS)) {
            if (await refileClosed(session.id)) refiled++;
        }

        return NextResponse.json({ expired: expired.length, autoVerdicts, autoAccepted, refiled });
    } catch (error) {
        console.error("[CouncilSweep] Error:", error);
        return NextResponse.json({ error: "Sweep failed." }, { status: 500 });
    }
}

// Filing is normally synchronous inside council_conclude; this covers a GitHub
// 5xx at that moment, where the verdict committed but the page did not.
async function refileClosed(sessionId: string): Promise<boolean> {
    const { getSessionById, listParticipants, markArchive } = await import("@/lib/council/store");
    const { writeVaultPage } = await import("@/lib/vault/ingest");
    const { vaultEmbeddingRef } = await import("@/lib/vault/store");

    const session = await getSessionById(sessionId);
    if (!session || !session.verdict) return false;
    try {
        const messages = await readTranscript({ sessionId, limit: 200 });
        const participants = await listParticipants(sessionId);
        const names = participants.filter((p) => p.kind === "agent").map((p) => p.name);
        const path = `wiki/synthesis/council-${session.code.toLowerCase()}.md`;
        const markdown = [
            `# Council ${session.code}: ${session.topic}`, "",
            `> Agent-authored debate transcript, filed unreviewed.`, "",
            `**Participants:** ${names.join(", ")}`, "",
            "## Verdict", "", session.verdict, "",
            "## Transcript", "",
            ...messages.map((m) => `**${m.speaker}** (${m.intent}, seq ${m.seq}): ${m.body.slice(0, 1200)}\n`),
        ].join("\n");
        const written = await writeVaultPage({
            path, markdown,
            summary: `Council debate on ${session.topic}`,
            trust: "untrusted", status: "suggested",
            embRef: await vaultEmbeddingRef(),
        });
        await markArchive({ sessionId, status: "filed", vaultPath: written.pagePath ?? path });
        return true;
    } catch (err) {
        console.warn("[CouncilSweep] refile failed:", err);
        return false;
    }
}
