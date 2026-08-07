import { addTodo } from "@/lib/db";
import { notify } from "@/lib/messaging/router";
import { writeVaultPage } from "@/lib/vault/ingest";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import {
    acceptVerdict, getSessionById, listParticipants, markArchive, proposeVerdict, readTranscript,
    validateWorkItems, type CouncilMessage, type CouncilSession, type CouncilWorkItemPlan,
} from "./store";
import { createCampaign, type CouncilWorkItemInput } from "./campaign";

// Persistence invariant: propose first, then finalize after owner acceptance.

const BODY_DIGEST_CHARS = 1200;
const VERDICT_SLICE = 1200;

export interface CloseOutcome {
    changed: boolean;
    verdict: string;
    closer: string;
    vaultPath: string | null;
    archiveError: string | null;
    campaignId: string | null;
}

export interface ProposeOutcome {
    changed: boolean;
    verdict: string;
    closer: string;
    status: string;
}

function transcriptMarkdown(session: CouncilSession, messages: CouncilMessage[], verdict: string, openQuestions: string[]): string {
    const lines = [
        `# Council ${session.code}: ${session.topic}`,
        "",
        `> Agent-authored debate transcript, filed unreviewed. Promote with vault_ingest if it`,
        `> deserves to be real knowledge.`,
        "",
        `**Brief:** ${session.brief}`,
        "",
        "## Verdict",
        "",
        verdict,
        "",
    ];
    if (openQuestions.length) {
        lines.push("## Open questions", "", ...openQuestions.map((q) => `- ${q}`), "");
    }
    lines.push("## Transcript", "");
    for (const m of messages) {
        lines.push(`**${m.speaker}** (${m.intent}${m.addressedTo !== "all" ? ` → ${m.addressedTo}` : ""}, seq ${m.seq}): ${m.body.slice(0, BODY_DIGEST_CHARS)}`, "");
    }
    return lines.join("\n");
}

export async function proposeCouncilVerdict(params: {
    session: CouncilSession;
    closer: string;
    verdict: string;
    openQuestions: string[];
    workItems?: CouncilWorkItemInput[];
}): Promise<ProposeOutcome> {
    const { session, closer, verdict, openQuestions, workItems } = params;

    // Validate before the verdict CAS to avoid an unfinalizable state.
    if (workItems?.length) {
        const reason = await validateWorkItems({ sessionId: session.id, createdBy: closer, workItems });
        if (reason) {
            throw new Error(
                `Work plan rejected: ${reason}. The council is still running and the verdict was not recorded - fix the plan and conclude again.`,
            );
        }
    }

    const cas = await proposeVerdict({
        sessionId: session.id, closer, verdict, openQuestions,
        workItems: workItems as CouncilWorkItemPlan[] | undefined,
    });
    if (!cas.changed) {
        return {
            changed: false,
            verdict: cas.verdict ?? "",
            closer: cas.closer ?? session.closerName,
            status: cas.status ?? session.status,
        };
    }

    const participants = await listParticipants(session.id);
    const names = participants.filter((p) => p.kind === "agent").map((p) => p.name);
    await notify(
        "council_conclusion",
        `**Council ${session.code} needs your decision** - ${session.topic}\n`
        + `${names.join(", ")} · ${session.round} rounds · ${session.lastSeq} messages\n\n`
        + `${verdict.slice(0, VERDICT_SLICE)}\n\n`
        + (openQuestions.length ? `Open: ${openQuestions.join("; ")}\n` : "")
        + `Accept it or send them back for more in /council. Nothing is filed until you do.`,
    ).catch((e) => console.warn("[Council] decision notice failed:", e));

    return { changed: true, verdict, closer, status: "awaiting_owner" };
}

export async function finalizeCouncil(session: CouncilSession): Promise<CloseOutcome> {
    const cas = await acceptVerdict(session.id);
    if (!cas.changed) {
        return {
            changed: false,
            verdict: cas.verdict ?? "",
            closer: cas.closer ?? session.closerName,
            vaultPath: cas.vaultPath ?? null,
            archiveError: null,
            campaignId: null,
        };
    }

    const verdict = cas.verdict ?? "";
    const closer = cas.closer ?? session.closerName;
    const openQuestions = session.openQuestions;

    let campaignId: string | null = null;
    if (cas.workItems.length) {
        // Debug: roster drift can invalidate a previously checked plan.
        try {
            const campaign = await createCampaign({
                sessionId: session.id, createdBy: closer, workItems: cas.workItems,
            });
            campaignId = campaign.campaign.id;
        } catch (err) {
            console.error("[Council] campaign creation failed after accept:", err);
        }
    }

    const [messages, participants] = await Promise.all([
        readTranscript({ sessionId: session.id, limit: 200 }),
        listParticipants(session.id),
    ]);
    const closed = (await getSessionById(session.id)) ?? session;
    const pagePath = `wiki/synthesis/council-${session.code.toLowerCase()}.md`;

    let vaultPath: string | null = null;
    let archiveError: string | null = null;
    try {
        const embRef = await vaultEmbeddingRef();
        const written = await writeVaultPage({
            path: pagePath,
            markdown: transcriptMarkdown(closed, messages, verdict, openQuestions),
            summary: `Council debate on ${closed.topic}; verdict: ${verdict.split("\n")[0].slice(0, 160)}`,
            trust: "untrusted",
            status: "suggested",
            embRef,
        });
        vaultPath = written.pagePath ?? pagePath;
        await markArchive({ sessionId: session.id, status: "filed", vaultPath });
    } catch (err) {
        archiveError = err instanceof Error ? err.message : String(err);
        console.error("[Council] Vault filing failed:", archiveError);
        await markArchive({ sessionId: session.id, status: "failed" });
    }

    const names = participants.filter((p) => p.kind === "agent").map((p) => p.name);
    // Notification failures must not roll back a committed verdict.
    await notify(
        "council_conclusion",
        `**Council concluded - ${closed.topic}**\n`
        + `${names.join(", ")} · ${closed.round} rounds · ${closed.lastSeq} messages\n\n`
        + `${verdict.slice(0, VERDICT_SLICE)}\n\n`
        + (openQuestions.length ? `Open: ${openQuestions.join("; ")}\n` : "")
        + (vaultPath ? `Filed (unreviewed draft): ${vaultPath}` : `Filed: FAILED - ${archiveError}`),
    ).catch((e) => console.warn("[Council] Discord announce failed:", e));

    for (const q of openQuestions) {
        await addTodo({
            title: `Follow up: ${q.slice(0, 80)}`,
            description: `Unresolved by council ${closed.code} (${closed.topic}).`,
            priority: "medium",
        }).catch((e) => console.warn("[Council] Follow-up todo failed:", e));
    }

    return { changed: true, verdict, closer, vaultPath, archiveError, campaignId };
}

export async function closeCouncil(params: {
    session: CouncilSession;
    closer: string;
    verdict: string;
    openQuestions: string[];
    workItems?: CouncilWorkItemInput[];
}): Promise<CloseOutcome> {
    const proposed = await proposeCouncilVerdict(params);
    const session = (await getSessionById(params.session.id)) ?? params.session;
    if (!proposed.changed && session.status !== "awaiting_owner") {
        return {
            changed: false,
            verdict: proposed.verdict,
            closer: proposed.closer,
            vaultPath: session.vaultPath,
            archiveError: null,
            campaignId: null,
        };
    }
    return finalizeCouncil(session);
}
