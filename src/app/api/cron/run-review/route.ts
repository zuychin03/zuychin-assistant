import { NextRequest, NextResponse } from "next/server";
import { Type } from "@google/genai";
import { ai, MODEL } from "@/lib/gemini";
import { getCronState, setCronState } from "@/lib/cron-state";
import { listAgentRuns, getAgentRun, type AgentRunSummary } from "@/lib/ai/agent/run-store";
// GUARDRAIL: only createDraftSkill may ever be imported from custom-store.
// Drafts stay invisible to the agent until approved in /admin; the update
// function (or passing a status) would let the cron self-approve its skills.
import { createDraftSkill, listCustomSkills } from "@/lib/ai/skills/custom-store";
import { SKILL_IDS } from "@/lib/ai/skills/registry";
import { sendTelegramMessage } from "@/lib/messaging/telegram-service";

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export const maxDuration = 60;

const STATE_KEY = "run_review";
const MIN_NEW_RUNS = 3;
const MAX_RUNS_TO_INSPECT = 5;
const MAX_DRAFTS = 2;
// Usage outliers: runs this expensive usually mean the agent flailed.
const OUTLIER_TOKENS = 150_000;
const OUTLIER_LLM_CALLS = 12;

function isOutlier(run: AgentRunSummary): boolean {
    if (run.status === "error" || run.status === "timeout") return true;
    const tokens = run.usage.totalTokens ?? 0;
    const calls = run.usage.llmCalls ?? 0;
    return tokens >= OUTLIER_TOKENS || calls >= OUTLIER_LLM_CALLS;
}

async function formatRunExcerpt(id: string): Promise<string | null> {
    const run = await getAgentRun(id);
    if (!run) return null;

    const planLines = run.plan.map((s) => `  - [${s.status}] ${s.title}`).join("\n");
    const eventLines = run.events
        .slice(-12)
        .map((e) => JSON.stringify(e).slice(0, 200))
        .join("\n");

    return [
        `### Run ${run.id} — status: ${run.status}`,
        `Task: ${run.message.slice(0, 300)}`,
        `Usage: ${run.usage.totalTokens ?? "?"} tokens, ${run.usage.llmCalls ?? "?"} LLM calls`,
        run.error ? `Error: ${run.error.slice(0, 300)}` : "",
        planLines ? `Plan:\n${planLines}` : "Plan: (none recorded)",
        eventLines ? `Last events:\n${eventLines}` : "",
        run.reply ? `Final reply excerpt: ${run.reply.slice(0, 200)}` : "",
    ].filter(Boolean).join("\n");
}

export async function POST(req: NextRequest) {
    const authHeader = req.headers.get("authorization");
    if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Unreadable state = hard abort: without the high-water mark every tick
    // would re-review the same runs and burn model calls.
    let mark: string | null;
    try {
        mark = (await getCronState<{ lastRunStartedAt: string }>(STATE_KEY))?.lastRunStartedAt ?? null;
    } catch (err) {
        console.error("[RunReview] State unavailable:", err);
        return NextResponse.json(
            { error: "cron_state unreadable — has the DDL been run?" },
            { status: 503 }
        );
    }

    // Still-running rows are excluded so the mark never skips past a run
    // whose outcome isn't known yet.
    const allRuns = await listAgentRuns(50);
    const newRuns = allRuns.filter(
        (r) => r.status !== "running" && (!mark || r.startedAt > mark)
    );

    if (newRuns.length < MIN_NEW_RUNS) {
        return NextResponse.json({ skipped: true, reason: "too_few_new_runs", newRuns: newRuns.length });
    }

    const newestStartedAt = newRuns
        .map((r) => r.startedAt)
        .sort()
        .at(-1)!;

    const candidates = newRuns.filter(isOutlier).slice(0, MAX_RUNS_TO_INSPECT);

    if (candidates.length === 0) {
        await setCronState(STATE_KEY, { lastRunStartedAt: newestStartedAt });
        return NextResponse.json({ drafts: 0, reviewed: newRuns.length, outliers: 0 });
    }

    const excerpts = (await Promise.all(candidates.map((r) => formatRunExcerpt(r.id))))
        .filter((x): x is string => !!x);

    const existingSlugs = new Set<string>([
        ...SKILL_IDS,
        ...(await listCustomSkills()).map((s) => s.slug),
    ]);

    const prompt = `You review failed or wasteful runs of an AI agent (Zuychin's agent mode) and distill REUSABLE skills that would have prevented the failure or waste. A skill is a named procedure the agent can load next time it faces the same kind of task.

Below are ${excerpts.length} problem runs (errors, timeouts, or unusually expensive). Look for recurring, generalizable causes: a tool used wrong, a missing step order, flailing that a checklist would prevent. Propose at most ${MAX_DRAFTS} skill drafts — proposing NONE is the right answer when the failures are one-off (transient API errors, user cancellations) or not generalizable.

Rules for drafts:
- slug: short kebab-case, must NOT be any of: ${[...existingSlugs].join(", ")}
- whenToUse: one sentence, phrased so an agent can match it against a task
- instructions: the concrete procedure, grounded ONLY in what these runs show — do not invent tool names or steps you cannot see evidence for
- rationale: which run(s) motivated it and why

Problem runs:

${excerpts.join("\n\n")}`;

    let drafts: { slug: string; name: string; whenToUse: string; instructions: string; rationale: string }[];
    try {
        const res = await ai.models.generateContent({
            model: MODEL,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        drafts: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    slug: { type: Type.STRING },
                                    name: { type: Type.STRING },
                                    whenToUse: { type: Type.STRING },
                                    instructions: { type: Type.STRING },
                                    rationale: { type: Type.STRING },
                                },
                                required: ["slug", "name", "whenToUse", "instructions", "rationale"],
                            },
                        },
                    },
                    required: ["drafts"],
                },
            },
        });
        drafts = (JSON.parse(res.text ?? "") as { drafts: typeof drafts }).drafts.slice(0, MAX_DRAFTS);
    } catch (err) {
        // Mark not advanced: the same runs get another chance next night.
        console.error("[RunReview] Draft call failed:", err);
        return NextResponse.json({ error: "Draft call failed." }, { status: 500 });
    }

    const filed: string[] = [];
    const rejected: { slug: string; reason: string }[] = [];
    for (const d of drafts) {
        if (existingSlugs.has(d.slug)) {
            rejected.push({ slug: d.slug, reason: "duplicate slug" });
            continue;
        }
        const result = await createDraftSkill({
            slug: d.slug,
            name: d.name,
            whenToUse: d.whenToUse,
            instructions: `${d.instructions}\n\n(Auto-drafted by run review: ${d.rationale})`,
            createdBy: "agent",
        });
        if (result.ok) filed.push(d.slug);
        else rejected.push({ slug: d.slug, reason: result.reason });
    }

    await setCronState(STATE_KEY, { lastRunStartedAt: newestStartedAt });

    if (filed.length > 0 && TELEGRAM_CHAT_ID) {
        await sendTelegramMessage(
            TELEGRAM_CHAT_ID,
            `🧠 Nightly run review filed ${filed.length} skill draft${filed.length > 1 ? "s" : ""} for approval in /admin: ${filed.join(", ")}`
        );
    }

    return NextResponse.json({
        drafts: filed.length,
        filed,
        rejected,
        reviewed: newRuns.length,
        outliers: candidates.length,
    });
}
