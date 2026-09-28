import { z } from "zod";

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const description = z.string().trim().min(1).max(4000);
const probability = z.number().finite().min(0).max(1);
const question = z.discriminatedUnion("type", [
    z.object({ type: z.literal("boolean"), instructions: description, criteria: z.object({ true: description, false: description }).strict().optional() }).strict(),
    z.object({ type: z.literal("choice"), instructions: description, criteria: z.record(name, description).refine(value => Object.keys(value).length >= 2 && Object.keys(value).length <= 255) }).strict(),
    z.object({ type: z.literal("score"), instructions: description, criteria: z.array(description).min(2).max(10) }).strict(),
]);
const requestSchema = z.object({ state: z.unknown(), questions: z.record(name, question).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 20) }).strict();
const answerSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("boolean"), probability }).strict(),
    z.object({ type: z.literal("choice"), choice: name, probabilities: z.record(z.string(), probability) }).strict(),
    z.object({ type: z.literal("score"), score: z.number().finite(), probabilities: z.record(z.string(), probability) }).strict(),
]);
export type JevRequest = z.infer<typeof requestSchema>;
export type JevAnswer = z.infer<typeof answerSchema> & { confidence: number | null };
export interface JevEnvelope extends JevRequest { model: "typesafe-ai/jev" }
type FallbackReason = "disabled" | "invalid_input" | "invalid_response" | "unavailable" | "timeout" | "uncertain";
export interface JevDecisionResult { status: "accepted" | "fallback"; reason?: FallbackReason; answers?: Record<string, JevAnswer>; durationMs: number }
type FixtureConfig = { mode: "fixture"; transport: (body: JevEnvelope, signal: AbortSignal) => Promise<unknown>; timeoutMs?: number; minimumProbability?: number; minimumConfidence?: number };

function validatedRequest(input: JevRequest) {
    const request = requestSchema.parse(input);
    const serialised = JSON.stringify(request, (_key, value) => {
        if (["undefined", "function", "symbol", "bigint"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Invalid JSON state");
        return value;
    });
    if (serialised.length > 64000 || request.state === null || !["string", "object"].includes(typeof request.state)) throw new Error("Invalid state");
    return request;
}

export function parseJevAnswers(input: JevRequest, raw: unknown): Record<string, JevAnswer> {
    const request = validatedRequest(input);
    const envelope = z.object({ answers: z.record(z.string(), answerSchema), providerMetadata: z.object({ typesafe: z.object({ confidence: z.record(z.string(), probability).optional() }).passthrough().optional() }).passthrough().optional() }).passthrough().parse(raw);
    const ids = Object.keys(request.questions);
    if (Object.keys(envelope.answers).length !== ids.length || ids.some(id => !Object.hasOwn(envelope.answers, id))) throw new Error("Answer IDs differ");
    const result: Record<string, JevAnswer> = {};
    for (const id of ids) {
        const expected = request.questions[id], answer = envelope.answers[id];
        if (answer.type !== expected.type) throw new Error("Answer type differs");
        if (answer.type !== "boolean") {
            const outcomes = expected.type === "choice" ? Object.keys(expected.criteria) : expected.type === "score" ? expected.criteria.map((_, index) => String(index)) : [];
            if (Object.keys(answer.probabilities).length !== outcomes.length || outcomes.some(key => !Object.hasOwn(answer.probabilities, key))) throw new Error("Outcomes differ");
            const values = outcomes.map(key => answer.probabilities[key]);
            if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.0001) throw new Error("Distribution is not normalised");
            if (answer.type === "choice" && (!outcomes.includes(answer.choice) || answer.probabilities[answer.choice] < Math.max(...values))) throw new Error("Invalid choice");
            if (answer.type === "score") {
                const mean = values.reduce((sum, value, index) => sum + value * index, 0);
                if (answer.score < 0 || answer.score > outcomes.length - 1 || Math.abs(mean - answer.score) > 0.0001) throw new Error("Invalid score");
            }
        }
        result[id] = { ...answer, confidence: answer.type === "boolean" ? null : envelope.providerMetadata?.typesafe?.confidence?.[id] ?? null };
    }
    return result;
}

// Live transport and shadow routing require the owner's plan, credit and retention decisions.
export function createJevDecisionClient(config?: FixtureConfig) {
    const timeoutMs = z.number().int().min(1).max(30000).parse(config?.timeoutMs ?? 3000);
    const minimumProbability = probability.min(0.5).parse(config?.minimumProbability ?? 0.8);
    const minimumConfidence = probability.parse(config?.minimumConfidence ?? 0.6);
    return {
        async evaluate(input: JevRequest): Promise<JevDecisionResult> {
            const start = performance.now();
            const fallback = (reason: FallbackReason, answers?: Record<string, JevAnswer>): JevDecisionResult => ({ status: "fallback", reason, ...(answers ? { answers } : {}), durationMs: Math.max(0, performance.now() - start) });
            if (!config || config.mode !== "fixture") return fallback("disabled");
            let request: JevRequest;
            try { request = validatedRequest(input); } catch { return fallback("invalid_input"); }
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let raw: unknown;
            try {
                raw = await Promise.race([
                    Promise.resolve().then(() => config.transport({ model: "typesafe-ai/jev", ...request }, controller.signal)),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, timeoutMs); }),
                ]);
            } catch { return fallback(controller.signal.aborted ? "timeout" : "unavailable"); }
            finally { if (timer) clearTimeout(timer); }
            let answers: Record<string, JevAnswer>;
            try { answers = parseJevAnswers(request, raw); } catch { return fallback("invalid_response"); }
            const uncertain = Object.values(answers).some(answer => {
                if (answer.type === "boolean") return Math.max(answer.probability, 1 - answer.probability) < minimumProbability;
                const selected = answer.type === "choice" ? answer.probabilities[answer.choice] : Math.max(...Object.values(answer.probabilities));
                return selected < minimumProbability || answer.confidence === null || answer.confidence < minimumConfidence;
            });
            return uncertain ? fallback("uncertain", answers) : { status: "accepted", answers, durationMs: Math.max(0, performance.now() - start) };
        },
    };
}

export const jevDecisions = createJevDecisionClient();
