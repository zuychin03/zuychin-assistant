import type { CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { familyKey, type ModelProfile, type ProfileRecord } from "@/lib/ai/models/profiles";
import { TAG_INFO, type PurposeTag } from "@/lib/ai/models/tags";
import { auDate, seconds } from "@/lib/ai/models/view";
import type { ModelSpeed } from "@/lib/ai/models/stats";

export interface VaultRoute {
    providerLabel: string;
    row: CatalogueRow;
    record: ProfileRecord;
    tags: PurposeTag[];
    speed: ModelSpeed;
    measured: string[];
}

export function modelVaultPath(modelId: string): string {
    const slug = familyKey(modelId).replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
    return `wiki/entities/model-${slug}.md`;
}

function speedLine(speed: ModelSpeed): string {
    if (speed.firstAnswerMs === null) return "No speed recorded";
    const tier = speed.tier.charAt(0).toUpperCase() + speed.tier.slice(1);
    return speed.source === "calls" ? `${tier}, median first answer ${seconds(speed.firstAnswerMs)} over ${speed.samples} calls` : `${tier}, ${seconds(speed.firstAnswerMs)} in its last test`;
}

const cell = (value: string) => value.replace(/\|/g, "/").replace(/\n/g, " ");

/** One page per model family, rebuilt from every approved route so the same model on several providers reads as one entity. */
export function modelVaultPage(routes: readonly VaultRoute[], now = new Date()): { markdown: string; summary: string } | null {
    const approved = routes.filter((route) => route.record.profile && route.record.approvedAt)
        .sort((a, b) => (b.record.approvedAt ?? "").localeCompare(a.record.approvedAt ?? ""));
    if (!approved.length) return null;
    const lead = approved[0];
    const profile = lead.record.profile as ModelProfile;
    const name = lead.row.label.replace(/\s*\(free\)$/i, "");
    const tags = [...new Set(approved.flatMap((route) => route.tags))];
    const sources = [...new Map(approved.flatMap((route) => route.record.profile?.sources ?? []).map((source) => [source.url, source])).values()];
    const facts = [profile.developer && `**Developer:** ${profile.developer}`, profile.params && `**Parameters:** ${profile.params}`].filter(Boolean).join(". ");
    const markdown = [
        `# ${name}`, "",
        `> Model profile approved on the assistant dashboard on ${auDate(lead.record.approvedAt!)}. Route facts were measured on ${auDate(now.toISOString())}.`, "",
        profile.description, "",
        ...(facts ? [`${facts}.`, ""] : []),
        "## Good for", "",
        ...(tags.length ? tags.map((tag) => `- ${TAG_INFO[tag].label}: ${TAG_INFO[tag].meaning}`) : ["- No purpose tags yet"]), "",
        ...(profile.strengths.length ? ["## Strengths", "", ...profile.strengths.map((line) => `- ${line}`), ""] : []),
        ...(profile.weaknesses.length ? ["## Weaknesses", "", ...profile.weaknesses.map((line) => `- ${line}`), ""] : []),
        "## Routes", "",
        "| Provider | Model id | Price | Speed | Measured |",
        "| --- | --- | --- | --- | --- |",
        ...approved.map((route) => `| ${cell(route.providerLabel)} | \`${cell(route.row.modelId)}\` | ${route.row.free ? "Free" : "Paid"} | ${cell(speedLine(route.speed))} | ${cell(route.measured.join("; ") || "Nothing flagged")} |`), "",
        ...(sources.length ? ["## Sources", "", ...sources.map((source) => `- [${source.title.replace(/[[\]]/g, "")}](${source.url})`), ""] : []),
    ].join("\n");
    const summary = `${name} model profile: ${profile.description}`.replace(/\s+/g, " ").slice(0, 240);
    return { markdown, summary };
}
