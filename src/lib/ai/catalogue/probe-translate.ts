import { DEFAULT_TRANSLATE_TEMPLATE, requestTranslate, type MediaRoute } from "@/lib/ai/media/requests";
import type { ProbeStep } from "@/lib/ai/catalogue/probe";
import { failedStep, observedProbeCall, type MediaProbeOptions, type MediaProbeResult } from "@/lib/ai/catalogue/probe-media";

export interface TranslateProbe {
    name: string;
    target: string;
    text: string;
    day: RegExp;
    /** Letters or words only the target language uses; at least `minMarks` must appear. */
    script: RegExp;
    minMarks: number;
    notScript?: RegExp;
}

// Each sentence holds a day, a time, a room and a date: the output must be in the target language, keep every number and name the day.
export const TRANSLATE_PROBES: readonly TranslateProbe[] = [
    {
        name: "vi", target: "Vietnamese", text: "The tutorial moved to Thursday at 15:30 in room 204 on 28/11/2026.",
        day: /thứ\s*(năm|5)(?![\p{L}\d])/iu, script: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu, minMarks: 3,
    },
    {
        name: "fr", target: "French", text: "The meeting is on Monday at 09:15 in room 12B, before 01/12/2026.",
        day: /(?<![\p{L}])lundi(?![\p{L}])/iu, script: /[éèêàçùâîôû]|(?<![\p{L}])(le|la|les|est|salle|réunion|avant)(?![\p{L}])/giu, minMarks: 2, notScript: /[åäößøæ]/iu,
    },
];
const PROBE_TIMEOUT_MS = 20_000;

/** Digit groups without leading zeros, so "09:15" and "9 h 15" agree. */
const numbers = (text: string) => (text.match(/\d+/g) ?? []).map((value) => String(Number(value)));

/** Why a translation fails the probe, or null when it passes. */
export function translationProblem(probe: TranslateProbe, output: string): string | null {
    const marks = output.match(probe.script)?.length ?? 0;
    if (marks < probe.minMarks || probe.notScript?.test(output)) return `Not ${probe.target}`;
    const have = new Set(numbers(output));
    const lost = numbers(probe.text).filter((value) => !have.has(value));
    if (lost.length) return `Changed or lost ${lost.join(", ")}`;
    if (!probe.day.test(output)) return "Wrong or missing day";
    return null;
}

/** Tests the row's own prompt template (from its model card), or the default one. */
export async function probeTranslate(route: MediaRoute, template: string | undefined, options: MediaProbeOptions = {}): Promise<MediaProbeResult> {
    const prompt = template ?? DEFAULT_TRANSLATE_TEMPLATE;
    const steps: Record<string, ProbeStep> = {};
    const times: number[] = [];
    let status: MediaProbeResult["status"] = "passed";
    for (const probe of TRANSLATE_PROBES) {
        const result = await observedProbeCall(route, () => requestTranslate(route, { text: probe.text, source: "English", target: probe.target, template: prompt, maxTokens: 200 }, { ...options, timeoutMs: PROBE_TIMEOUT_MS }));
        if (!result.ok) {
            steps[probe.name] = failedStep(result);
            if (result.status === 410) return { status: "failed", retired: true, retiredAt: result.retiredAt, ms: null, traits: {}, steps };
            status = status === "failed" || !result.transient ? "failed" : "inconclusive";
            continue;
        }
        times.push(result.ms);
        const problem = translationProblem(probe, result.value);
        steps[probe.name] = { outcome: problem ? "fail" : "pass", httpStatus: result.status, ms: result.ms, detail: `${problem ? `${problem}: ` : ""}"${result.value.slice(0, 120)}"` };
        if (problem) status = "failed";
    }
    const ms = times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : null;
    return { status, retired: false, retiredAt: null, ms, traits: status === "passed" ? { promptTemplate: prompt } : {}, steps };
}
