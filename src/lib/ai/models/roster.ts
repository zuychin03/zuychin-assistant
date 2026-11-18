import { automaticRouteEligible, chatModelUsable, isProviderAvailable, providers, WORKER_GEMINI_FALLBACK, WORKER_PREFERRED, type ChatModel, type ProviderConfig } from "@/lib/ai/providers";
import { catalogueSnapshot, type CatalogueRow } from "@/lib/ai/catalogue/snapshot";
import { feedbackScore, statsKey, statsSnapshot, SPEED_WINDOW_DAYS, type ModelFeedback, type ModelSpeed, type SpeedStats } from "@/lib/ai/models/stats";
import { PURPOSE_TAGS, TAG_INFO, tagBlockedReason, type PurposeTag, type TagsSource } from "@/lib/ai/models/tags";
import type { ProfileRecord } from "@/lib/ai/models/profiles";
import { measuredFacts, modelView, resolveSpeed, resolveTags, seconds, type ModelView } from "@/lib/ai/models/view";

export interface RosterPolicy {
    freeOnly: boolean;
    /** The orchestrator runs on a paid model, so explicit hints and consult calls may use paid models. */
    paidOrchestrator: boolean;
    /** Scheduled runs: the data policy allows paid Gemini generation only. */
    unattended: boolean;
}

export interface RosterEntry {
    key: string;
    providerId: string;
    providerLabel: string;
    providerKind: ProviderConfig["kind"];
    modelId: string;
    name: string;
    label: string;
    free: boolean;
    paid: boolean;
    approved: boolean;
    /** Removed from the selectable list on the dashboard. */
    removed: boolean;
    status: "new" | "missing" | "failing" | null;
    tags: PurposeTag[];
    tagsSource: TagsSource;
    speed: ModelSpeed;
    caps: { tools: boolean; vision: boolean; search: boolean; structured: boolean };
    feedback: ModelFeedback;
    view: ModelView | null;
    measured: string[];
    /** Automatic purpose picks for workers. */
    autoEligible: boolean;
    /** Explicit hints, ask_model and compare_models. */
    hintEligible: boolean;
    reason: string | null;
    /** Position in WORKER_PREFERRED, used to break ties. */
    order: number;
}

export interface RosterInputs {
    providers: readonly ProviderConfig[];
    rows: readonly CatalogueRow[];
    profiles: readonly ProfileRecord[];
    speed: ReadonlyMap<string, SpeedStats>;
    feedback: ReadonlyMap<string, ModelFeedback>;
    available: (provider: ProviderConfig) => boolean;
}

const MAX_PURPOSE_CHAIN = 6;

function isPaid(provider: ProviderConfig, model: ChatModel): boolean {
    return model.free !== true || model.metered === true || provider.metered === true;
}

function blockedReason(provider: ProviderConfig, model: ChatModel, available: boolean, policy: RosterPolicy): string | null {
    if (model.catalogue?.removed) return "Removed from the model list on the dashboard";
    if (!available) return provider.unavailableReason ? `${provider.label} is unavailable` : `${provider.label} has no API key`;
    if (!chatModelUsable(model)) return "Needs the Responses API, which this app does not support yet";
    if (model.catalogue?.status === "missing") return "Missing from the provider's model list";
    if (!automaticRouteEligible(model)) return "Not approved on the dashboard yet";
    if (policy.unattended && !(provider.id === "gemini" && model.free !== true)) return "Scheduled runs may use paid Gemini only";
    if (policy.freeOnly && model.free !== true) return "Free only is on";
    if (isPaid(provider, model) && !policy.paidOrchestrator) return "Paid, and this run's orchestrator is on a free model";
    return null;
}

export function buildRoster(inputs: RosterInputs, policy: RosterPolicy): RosterEntry[] {
    const rows = new Map(inputs.rows.map((row) => [statsKey(row.providerId, row.modelId), row]));
    const profiles = new Map(inputs.profiles.map((profile) => [statsKey(profile.providerId, profile.modelId), profile]));
    const preferred = WORKER_PREFERRED.map((entry) => statsKey(entry.providerId, entry.modelId));
    const entries: RosterEntry[] = [];
    for (const provider of inputs.providers) {
        const available = inputs.available(provider);
        for (const model of provider.chatModels) {
            const key = statsKey(provider.id, model.id);
            const row = rows.get(key), profile = profiles.get(key);
            const speed = resolveSpeed(provider.id, model, inputs.speed);
            const { tags, source } = resolveTags(model, profile, row);
            const status = model.catalogue?.status ?? null;
            const reason = blockedReason(provider, model, available, policy);
            const paid = isPaid(provider, model);
            const order = preferred.indexOf(key);
            entries.push({
                key, providerId: provider.id, providerLabel: provider.label, providerKind: provider.kind, modelId: model.id, name: model.name, label: model.label,
                free: model.free === true, paid, approved: automaticRouteEligible(model), removed: model.catalogue?.removed === true, status, tags, tagsSource: source, speed,
                caps: { tools: model.supportsTools, vision: model.supportsVision, search: model.supportsSearch, structured: model.supportsStructuredOutput === true },
                feedback: inputs.feedback.get(key) ?? {}, view: modelView(model, profile, row, speed), measured: measuredFacts(model, row, speed),
                // Gemini stays the worker's explicit final fallback, as in resolveWorkerChain.
                autoEligible: reason === null && !paid && status !== "failing" && provider.kind !== "gemini",
                hintEligible: reason === null,
                reason, order: order === -1 ? Number.MAX_SAFE_INTEGER : order,
            });
        }
    }
    return entries;
}

export function currentRoster(policy: RosterPolicy): RosterEntry[] {
    const catalogue = catalogueSnapshot(), stats = statsSnapshot();
    return buildRoster({ providers: providers(), rows: catalogue.rows, profiles: catalogue.profiles, speed: stats.speed, feedback: stats.feedback, available: isProviderAvailable }, policy);
}

const SPEED_POINTS = { fast: 2, medium: 1, slow: -2, unknown: 0 } as const;

export function scoreEntry(entry: RosterEntry, purpose: PurposeTag | null): number {
    let score = SPEED_POINTS[entry.speed.tier];
    if (purpose && entry.tags.includes(purpose)) score += 3;
    if (entry.speed.reliable === false) score -= 3;
    score += feedbackScore(purpose ? entry.feedback[purpose] : entry.feedback.all);
    return score;
}

export interface Needs {
    tools: boolean;
    vision: boolean;
}

function meetsNeeds(entry: RosterEntry, purpose: PurposeTag | null, needs: Needs): boolean {
    if (needs.tools && !entry.caps.tools) return false;
    if (needs.vision && !entry.caps.vision) return false;
    return !purpose || tagBlockedReason(purpose, { supportsTools: entry.caps.tools, supportsVision: entry.caps.vision }) === null;
}

function byScore(purpose: PurposeTag | null) {
    return (a: RosterEntry, b: RosterEntry) => scoreEntry(b, purpose) - scoreEntry(a, purpose) || a.order - b.order || a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
}

/** Worker candidates for a purpose: free, approved, not failing, best first. */
export function rankForPurpose(entries: readonly RosterEntry[], purpose: PurposeTag | null, needs: Needs, limit = MAX_PURPOSE_CHAIN): RosterEntry[] {
    return entries.filter((entry) => entry.autoEligible && meetsNeeds(entry, purpose, needs)).sort(byScore(purpose)).slice(0, limit);
}

/** Models this run may name: automatic picks first, then the ones only a hint can use. */
export function listForRun(entries: readonly RosterEntry[], purpose: PurposeTag | null, needs: Needs): RosterEntry[] {
    const usable = entries.filter((entry) => entry.hintEligible && meetsNeeds(entry, purpose, needs));
    const sorter = byScore(purpose);
    return usable.sort((a, b) => Number(b.autoEligible) - Number(a.autoEligible) || sorter(a, b));
}

/** A `provider::model` key, a model id or a short name. Ambiguous names prefer models this run may use. */
export function findEntry(entries: readonly RosterEntry[], ref: string): RosterEntry | null {
    const wanted = ref.trim().toLowerCase();
    if (!wanted) return null;
    const exact = entries.find((entry) => entry.key.toLowerCase() === wanted);
    if (exact) return exact;
    const matches = entries.filter((entry) => entry.modelId.toLowerCase() === wanted || entry.name.toLowerCase() === wanted);
    return matches.find((entry) => entry.autoEligible) ?? matches.find((entry) => entry.hintEligible) ?? matches[0] ?? null;
}

function speedText(speed: ModelSpeed): string {
    if (speed.firstAnswerMs === null) return "speed unknown";
    const basis = speed.source === "calls" ? `${speed.samples} calls` : "1 test";
    const rate = speed.tokensPerSecond !== null ? `, ${Math.round(speed.tokensPerSecond)} tokens/s` : "";
    return `${speed.tier}, first answer ${seconds(speed.firstAnswerMs)} (${basis})${rate}`;
}

function capsText(entry: RosterEntry): string {
    const caps = [entry.caps.tools && "tools", entry.caps.search && "search", entry.caps.vision && "vision"].filter(Boolean);
    return caps.length ? caps.join("+") : "text only";
}

function feedbackText(entry: RosterEntry, purpose: PurposeTag | null): string {
    const count = purpose ? entry.feedback[purpose] : entry.feedback.all;
    if (!count || count.useful + count.notUseful === 0) return "";
    return `, rated useful ${count.useful}/${count.useful + count.notUseful}${purpose ? ` for ${purpose}` : ""}`;
}

export function rosterLine(entry: RosterEntry, purpose: PurposeTag | null): string {
    const rate = entry.speed.successRate !== null && entry.speed.calls > 0 ? `, ${Math.round(entry.speed.successRate * 100)}% of ${entry.speed.calls} calls ok` : "";
    const use = entry.autoEligible ? "" : " [hint only]";
    return `- ${entry.key}: ${entry.label} (${entry.providerLabel}), ${entry.paid ? "paid" : "free"}${use}, tags ${entry.tags.join("/") || "none"}, ${speedText(entry.speed)}${rate}, ${capsText(entry)}${feedbackText(entry, purpose)}`;
}

export function policyLine(policy: RosterPolicy): string {
    if (policy.unattended) return "Scheduled run: only paid Gemini may generate, so workers run on the paid Gemini fallback.";
    if (policy.freeOnly) return "Free only is on: every model below is free, and there is no paid fallback.";
    return policy.paidOrchestrator
        ? "The orchestrator is on a paid model: hints, ask_model and compare_models may name paid models. Purpose picks stay free."
        : "The orchestrator is on a free model: hints, ask_model and compare_models use free models only.";
}

export function formatRoster(entries: readonly RosterEntry[], policy: RosterPolicy, purpose: PurposeTag | null, needs: Needs, limit = 20): string {
    const listed = listForRun(entries, purpose, needs);
    const lines = [
        `Models ${purpose ? `for ${purpose} (${TAG_INFO[purpose].meaning.toLowerCase()})` : "for any purpose"}: ${listed.length} usable${listed.length > limit ? `, best ${limit} shown` : ""}. Speed is measured over ${SPEED_WINDOW_DAYS} days.`,
        policyLine(policy),
        ...listed.slice(0, limit).map((entry) => rosterLine(entry, purpose)),
    ];
    if (!listed.length) lines.push("No model fits. Drop a requirement, or let run_subagents use its default chain.");
    if (!policy.freeOnly && !policy.unattended) lines.push(`Fallback: paid Gemini (${WORKER_GEMINI_FALLBACK.simple} for simple, ${WORKER_GEMINI_FALLBACK.complex} for complex subtasks) runs when every free worker fails.`);
    lines.push("Use a key as run_subagents task.model, ask_model.model or compare_models.models, or set task.purpose and let the app pick. Call list_models with model=<key> for strengths and weaknesses.");
    return lines.join("\n");
}

export function formatModelDetail(entry: RosterEntry, policy: RosterPolicy): string {
    const view = entry.view;
    const lines = [
        `${entry.label} (${entry.providerLabel}), key ${entry.key}`,
        `${entry.paid ? "Paid" : "Free"}. ${entry.hintEligible ? entry.autoEligible ? "Usable by purpose picks and hints." : "Usable by hints only." : `Not usable on this run: ${entry.reason}.`}${entry.status ? ` Status: ${entry.status}.` : ""}`,
        `Tags: ${entry.tags.join(", ") || "none"} (${entry.tagsSource}).`,
        `Speed: ${speedText(entry.speed)}${entry.speed.p90FirstAnswerMs !== null ? `, slowest tenth ${seconds(entry.speed.p90FirstAnswerMs)}` : ""}.${entry.speed.successRate !== null ? ` ${Math.round(entry.speed.successRate * 100)}% of ${entry.speed.calls} calls succeeded.` : ""}`,
        `Capabilities: ${capsText(entry)}${entry.caps.structured ? ", structured output" : ""}.`,
    ];
    if (view?.description) lines.push(`About: ${view.description}${view.origin === "listing" ? " (provider listing, not reviewed)" : ""}`);
    if (view?.strengths.length) lines.push(`Strengths: ${view.strengths.join("; ")}`);
    if (view?.weaknesses.length) lines.push(`Weaknesses: ${view.weaknesses.join("; ")}`);
    if (entry.measured.length) lines.push(`Measured: ${entry.measured.join("; ")}`);
    const rated = PURPOSE_TAGS.flatMap((tag) => {
        const count = entry.feedback[tag];
        return count && count.useful + count.notUseful > 0 ? [`${tag} ${count.useful}/${count.useful + count.notUseful}`] : [];
    });
    if (rated.length) lines.push(`Worker ratings (useful/total): ${rated.join(", ")}`);
    lines.push(policyLine(policy));
    return lines.join("\n");
}

/** A few lines for the orchestrator prompt: the best one or two picks per purpose. */
export function formatRosterSummary(entries: readonly RosterEntry[], policy: RosterPolicy): string | null {
    if (policy.unattended) return null;
    const lines: string[] = [];
    for (const purpose of PURPOSE_TAGS) {
        const picks = rankForPurpose(entries, purpose, { tools: TAG_INFO[purpose].requires === "tools", vision: purpose === "vision" }, 2)
            .filter((entry) => entry.tags.includes(purpose));
        if (picks.length) lines.push(`- ${purpose}: ${picks.map((entry) => `${entry.key} (${entry.speed.tier}${entry.speed.firstAnswerMs !== null ? ` ${seconds(entry.speed.firstAnswerMs)}` : ""})`).join(", ")}`);
    }
    if (!lines.length) return null;
    return `MODELS - best free worker picks by purpose. Set purpose on run_subagents tasks to pick automatically; call list_models for every model, speed and weaknesses.\n${lines.join("\n")}`;
}
