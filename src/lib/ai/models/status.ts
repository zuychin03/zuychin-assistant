import { rankForPurpose, type RosterEntry } from "@/lib/ai/models/roster";
import { TAG_INFO, type PurposeTag } from "@/lib/ai/models/tags";
import type { ProfileRecord } from "@/lib/ai/models/profiles";
import { seconds } from "@/lib/ai/models/view";

export type StatusView = "problems" | "all" | "drafts";

export interface StatusRun {
    startedAt: string;
    trigger: string;
    status: string;
    summary: Record<string, unknown>;
}

const LIST_MAX = 8;

function melbourne(value: string): string {
    return new Date(value).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function runLine(run: StatusRun | undefined): string {
    if (!run) return "No model check has run yet.";
    const count = (key: string) => Array.isArray(run.summary[key]) ? (run.summary[key] as unknown[]).length : 0;
    const when = `${melbourne(run.startedAt)} Melbourne time (${run.trigger === "cron" ? "daily" : "manual"})`;
    if (run.status === "running") return `A model check started ${when} and is still running.`;
    if (run.status === "failed") return `The last model check, ${when}, failed: ${typeof run.summary.error === "string" ? run.summary.error : "no reason was recorded"}.`;
    return `Last model check ${when}: ${count("added")} added, ${count("passed")} passed, ${count("newlyMissing")} newly missing, ${count("drafted")} profiles drafted.`;
}

const names = (entries: readonly RosterEntry[]) => entries.slice(0, LIST_MAX).map((entry) => entry.key).join(", ") + (entries.length > LIST_MAX ? `, and ${entries.length - LIST_MAX} more` : "");

/** Read-only digest for chat and the channels: no model is called. */
export function formatModelStatus(input: { roster: readonly RosterEntry[]; runs: readonly StatusRun[]; profiles: readonly ProfileRecord[]; show: StatusView; purpose: PurposeTag | null }): string {
    const live = input.roster.filter((entry) => !entry.removed && (entry.reason === null || !/unavailable|no API key/.test(entry.reason)));
    const lastRun = input.runs.find((run) => run.summary.kind !== "test" && run.summary.kind !== "lookup");
    const lines = [runLine(lastRun)];

    const failing = live.filter((entry) => entry.status === "failing");
    const missing = live.filter((entry) => entry.status === "missing");
    const unreliable = live.filter((entry) => entry.speed.reliable === false);
    const slow = live.filter((entry) => entry.speed.tier === "slow" && entry.status !== "missing");
    const drafts = input.profiles.filter((profile) => profile.draftStatus === "ready");

    if (input.show !== "drafts") {
        const problems = [
            failing.length && `Failed their last test (${failing.length}): ${names(failing)}.`,
            missing.length && `Missing from the provider list (${missing.length}): ${names(missing)}.`,
            unreliable.length && `Under 80% of calls succeeded in 14 days (${unreliable.length}): ${unreliable.slice(0, LIST_MAX).map((entry) => `${entry.key} ${Math.round((entry.speed.successRate ?? 0) * 100)}%`).join(", ")}.`,
            slow.length && `Slow first answer, over 20 s (${slow.length}): ${slow.slice(0, LIST_MAX).map((entry) => `${entry.key} ${entry.speed.firstAnswerMs !== null ? seconds(entry.speed.firstAnswerMs) : ""}`.trim()).join(", ")}.`,
        ].filter(Boolean) as string[];
        lines.push(...(problems.length ? problems : ["No failing, missing, unreliable or slow models right now."]));
    }
    if (input.show === "all") {
        const tiers = { fast: 0, medium: 0, slow: 0, unknown: 0 };
        for (const entry of live) tiers[entry.speed.tier] += 1;
        lines.push(`${live.length} chat models on available providers: ${tiers.fast} fast, ${tiers.medium} medium, ${tiers.slow} slow, ${tiers.unknown} not measured yet.`);
    }
    if (input.show === "drafts" || drafts.length) {
        lines.push(drafts.length
            ? `Profile drafts waiting for review on the dashboard (${drafts.length}): ${drafts.slice(0, LIST_MAX).map((profile) => `${profile.providerId}::${profile.modelId}`).join(", ")}${drafts.length > LIST_MAX ? ", and more" : ""}.`
            : "No profile drafts are waiting for review.");
    }
    if (input.purpose) {
        const top = rankForPurpose(input.roster, input.purpose, { tools: TAG_INFO[input.purpose].requires === "tools", vision: input.purpose === "vision" }, 3);
        lines.push(top.length
            ? `Best free picks for ${input.purpose}: ${top.map((entry) => `${entry.key} (${entry.speed.tier}${entry.speed.firstAnswerMs !== null ? `, ${seconds(entry.speed.firstAnswerMs)}` : ""})`).join("; ")}.`
            : `No free model is approved for ${input.purpose} right now.`);
    }
    return lines.join("\n");
}
