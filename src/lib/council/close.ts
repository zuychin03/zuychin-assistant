import { addTodo } from "@/lib/db";
import { notify } from "@/lib/messaging/router";
import { writeVaultPage } from "@/lib/vault/ingest";
import { vaultEmbeddingRef } from "@/lib/vault/store";
import {
    concludeCouncil, getSessionById, listParticipants, markArchive, readTranscript,
    type CouncilMessage, type CouncilSession,
} from "./store";
import { createCampaign, type CouncilWorkItemInput } from "./campaign";

// Order is load-bearing: the DB CAS commits FIRST, so a client-side timeout can
// never lose an agreed verdict. Nothing is deferred to after() -- its callbacks
// run only once mcp-handler's stream adapter closes, on an instance Vercel may
// freeze, and a failure there is a console.error nobody reads. This is the only
// path that produces durable output, so it runs where the agent can see it.

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

export async function closeCouncil(params: {
    session: CouncilSession;
    closer: string;
    verdict: string;
    openQuestions: string[];
    workItems?: CouncilWorkItemInput[];
}): Promise<CloseOutcome> {
    const { session, closer, verdict, openQuestions, workItems } = params;

    // The CAS is the mutex: two agents concluding simultaneously cannot both
    // race a vault write against the GitHub ref.
    const cas = await concludeCouncil({
        sessionId: session.id, closer, verdict, openQuestions,
    });
    if (!cas.changed) {
        const campaignId = workItems?.length
            ? (await createCampaign({ sessionId: session.id, createdBy: closer, workItems })).campaign.id
            : null;
        return {
            changed: false,
            verdict: cas.verdict ?? "",
            closer: cas.closer ?? session.closerName,
            vaultPath: cas.vaultPath ?? null,
            archiveError: null,
            campaignId,
        };
    }

    let campaignId: string | null = null;
    if (workItems?.length) {
        const campaign = await createCampaign({ sessionId: session.id, createdBy: closer, workItems });
        campaignId = campaign.campaign.id;
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
    // notify() can reject via its Telegram and push legs and the DB write has
    // already committed, so every mirror is catch-wrapped.
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
