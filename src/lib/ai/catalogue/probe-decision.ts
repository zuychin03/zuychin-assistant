import { requestDecision, type DecisionAnswer, type DecisionQuestion, type MediaRoute } from "@/lib/ai/media/requests";
import { failedProbe, observedProbeCall, type MediaProbeOptions, type MediaProbeResult } from "@/lib/ai/catalogue/probe-media";

// One public input with three questions whose answers are not in doubt.
export const DECISION_PROBE_INPUT = "Reminder: the dentist appointment is tomorrow at 9 am. Please arrive ten minutes early.";
export const DECISION_PROBE_QUESTIONS = {
    appointment: { type: "noul", instructions: "Does the text describe an upcoming appointment?" },
    topic: {
        type: "choice", instructions: "What is the text about?",
        criteria: { health: "Medical, dental or wellbeing matters.", cooking: "Recipes and food preparation.", sport: "Games, matches and exercise." },
    },
    urgency: { type: "score", instructions: "How soon does this need attention?", criteria: ["Not urgent", "This week", "Today or tomorrow"] },
} satisfies Record<string, DecisionQuestion>;
const PROBE_TIMEOUT_MS = 20_000;

const numeric = (answer: DecisionAnswer) => answer.type === "choice" ? Number.NaN : answer.value;

export async function probeDecision(route: MediaRoute, options: MediaProbeOptions = {}): Promise<MediaProbeResult> {
    const result = await observedProbeCall(route, () => requestDecision(route, DECISION_PROBE_INPUT, DECISION_PROBE_QUESTIONS, { ...options, timeoutMs: PROBE_TIMEOUT_MS }));
    if (!result.ok) return failedProbe("decision", result);
    const { appointment, topic, urgency } = result.value;
    const chosen = topic.type === "choice" ? topic.value : "?";
    const wrong = [
        ...(numeric(appointment) >= 0.5 ? [] : ["yes/no"]),
        ...(chosen === "health" ? [] : ["choice"]),
        ...(numeric(urgency) >= 1 ? [] : ["score"]),
    ];
    const ok = !wrong.length;
    const shown = `yes/no ${numeric(appointment).toFixed(2)}, choice ${chosen}, score ${numeric(urgency).toFixed(2)}`;
    return {
        status: ok ? "passed" : "failed", retired: false, retiredAt: null, ms: result.ms, traits: {},
        steps: { decision: { outcome: ok ? "pass" : "fail", httpStatus: result.status, ms: result.ms, detail: ok ? `${shown}.` : `Wrong ${wrong.join(", ")}: ${shown}.` } },
    };
}
