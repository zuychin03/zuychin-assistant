import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { GoogleGenAI } from "@google/genai";
import { requestUsage, type CompatUsage } from "@/lib/ai/stream-usage";
import { assessDataRoute, assertDataRouteAllowed, mergeDataClasses, type ModelDataClass, type DataRouteAssessment } from "@/lib/ai/data-policy";

export type ModelCallPurpose = "chat" | "embedding" | "routing" | "worker" | "orchestration" | "compaction" | "continuation" | "extraction" | "summary" | "title" | "search" | "speech" | "study";
export type ModelCallStatus = "success" | "auth" | "rate_limit" | "transient" | "unavailable" | "retired" | "aborted" | "unknown";
export type ModelErrorClass = "http" | "abort" | "timeout" | "transport" | "unknown";
export interface ModelCallObservation {
    id: string;
    providerId: string;
    modelId: string;
    purpose: ModelCallPurpose;
    startedAt: string;
    durationMs: number;
    firstAnswerMs: number | null;
    status: ModelCallStatus;
    errorClass: ModelErrorClass | null;
    httpStatus: number | null;
    usage: CompatUsage;
    capabilities: { streaming: boolean; tools: boolean; vision: boolean; grounding: boolean };
    dataClasses?: ModelDataClass[];
    dataRoute?: DataRouteAssessment;
    groundingRequested?: boolean;
}

export interface ExternalServiceObservation extends Pick<ModelCallObservation, "id" | "providerId" | "startedAt" | "durationMs" | "status" | "errorClass" | "httpStatus"> {
    operation: "web_search";
    dataClasses?: ModelDataClass[];
}
interface ObservationContext { observations: ModelCallObservation[]; externalServices?: ExternalServiceObservation[]; purpose?: ModelCallPurpose; classes: ModelDataClass[]; policy?: { freeOnly: boolean } }
const scope = new AsyncLocalStorage<ObservationContext>();
export function withModelObservationCollector<T>(observations: ModelCallObservation[], fn: () => T, externalServices?: ExternalServiceObservation[], classes: ModelDataClass[] = []): T {
    return scope.run({ observations, externalServices, classes: mergeDataClasses(classes) }, fn);
}
export function configureModelDataPolicy(freeOnly: boolean) { const current = scope.getStore(); if (current) current.policy = { freeOnly }; }
export function addModelDataClasses(classes: ModelDataClass[]) { const current = scope.getStore(); if (current) current.classes = mergeDataClasses(current.classes, classes); }
export function withModelDataClasses<T>(classes: ModelDataClass[], fn: () => T, replace = false): T {
    const current = scope.getStore();
    return current ? scope.run({ ...current, classes: mergeDataClasses(replace ? current.classes.filter(value => value === "unattended") : current.classes, classes) }, fn) : fn();
}
export async function collectModelObservations<T>(fn: () => Promise<T>, classes: ModelDataClass[] = []): Promise<{ value: T; observations: ModelCallObservation[]; externalServices: ExternalServiceObservation[] }> {
    const observations: ModelCallObservation[] = [];
    const externalServices: ExternalServiceObservation[] = [];
    const value = await withModelObservationCollector(observations, fn, externalServices, classes);
    return { value, observations, externalServices };
}
export function withModelPurpose<T>(purpose: ModelCallPurpose, fn: () => T): T {
    const current = scope.getStore();
    return current ? scope.run({ ...current, purpose }, fn) : fn();
}

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
export function classifyModelError(error: unknown): Pick<ModelCallObservation, "status" | "errorClass" | "httpStatus"> {
    const value = object(error);
    const rawStatus = value.status ?? value.statusCode ?? value.code;
    const httpStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
    if (value.name === "AbortError") return { status: "aborted", errorClass: "abort", httpStatus };
    if (value.name === "TimeoutError") return { status: "transient", errorClass: "timeout", httpStatus };
    const status: ModelCallStatus = httpStatus === 401 || httpStatus === 403 ? "auth"
        : httpStatus === 429 ? "rate_limit"
            : httpStatus === 404 ? "unavailable"
                : httpStatus === 410 ? "retired"
                    : httpStatus !== null && (httpStatus >= 500 || httpStatus === 408) ? "transient" : "unknown";
    return { status, errorClass: httpStatus !== null ? "http" : value.name === "TypeError" ? "transport" : "unknown", httpStatus };
}

export function beginModelObservation(identity: { providerId: string; modelId: string; purpose: ModelCallPurpose }) {
    const current = scope.getStore();
    const purpose = current?.purpose ?? identity.purpose;
    const dataClasses = mergeDataClasses(current?.classes);
    const dataRoute = assessDataRoute({ ...identity, purpose, classes: dataClasses, freeOnly: current?.policy?.freeOnly });
    if (current?.policy) assertDataRouteAllowed(dataRoute);
    const started = performance.now();
    let finished = false;
    const observation: ModelCallObservation | undefined = current ? {
        id: randomUUID(), ...identity, purpose, dataClasses, dataRoute,
        startedAt: new Date().toISOString(), durationMs: 0, firstAnswerMs: null,
        status: "unknown", errorClass: null, httpStatus: null, usage: requestUsage(undefined, false),
        capabilities: { streaming: false, tools: false, vision: false, grounding: false },
    } : undefined;
    return {
        firstAnswer() {
            if (observation && observation.firstAnswerMs === null) observation.firstAnswerMs = Math.max(0, performance.now() - started);
        },
        capability(capability: keyof ModelCallObservation["capabilities"]) {
            if (observation) observation.capabilities[capability] = true;
        },
        requestGrounding() {
            if (current) current.classes = mergeDataClasses(current.classes, ["public_search"]);
            if (observation) { observation.groundingRequested = true; observation.dataClasses = mergeDataClasses(observation.dataClasses, ["public_search"]); }
        },
        finish(result: { usage?: CompatUsage; status?: ModelCallStatus; error?: unknown } = {}) {
            if (!observation || finished) return;
            finished = true;
            observation.durationMs = Math.max(0, performance.now() - started);
            if (result.error !== undefined) Object.assign(observation, classifyModelError(result.error));
            observation.status = result.status ?? (result.error === undefined ? "success" : observation.status);
            observation.usage = result.usage ?? requestUsage(undefined, false);
            current!.observations.push(observation);
        },
    };
}

export function beginExternalServiceObservation(identity: Pick<ExternalServiceObservation, "providerId" | "operation">) {
    const current = scope.getStore();
    const target = current?.externalServices;
    const dataClasses = mergeDataClasses(current?.classes, ["public_search"]);
    const started = performance.now();
    const startedAt = new Date().toISOString();
    let finished = false;
    return {
        finish(result: { status?: ModelCallStatus; error?: unknown } = {}) {
            if (!target || finished) return;
            finished = true;
            const failure = result.error === undefined ? { status: "success" as const, errorClass: null, httpStatus: null } : classifyModelError(result.error);
            target.push({ id: randomUUID(), ...identity, dataClasses, startedAt, durationMs: Math.max(0, performance.now() - started),
                ...failure, status: result.status ?? failure.status });
        },
    };
}

export function geminiUsage(raw: unknown, finished: boolean): CompatUsage {
    const value = object(raw);
    return requestUsage({ prompt_tokens: value.promptTokenCount, completion_tokens: value.candidatesTokenCount,
        total_tokens: value.totalTokenCount, prompt_tokens_details: { cached_tokens: value.cachedContentTokenCount } }, finished);
}

type GeminiModels = Pick<GoogleGenAI["models"], "generateContent" | "generateContentStream" | "embedContent">;
export type ObservedGeminiClient = { models: GeminiModels };
const originalClients = new WeakMap<ObservedGeminiClient, ObservedGeminiClient>();

export function observeGeminiClient(client: ObservedGeminiClient, identity: { providerId: string; purpose: ModelCallPurpose }): ObservedGeminiClient {
    client = originalClients.get(client) ?? client;
    const requestsGrounding = (tools: unknown) => Array.isArray(tools) && tools.some(tool => {
        const value = object(tool); return !!(value.googleSearch || value.googleMaps || value.urlContext || value.googleSearchRetrieval);
    });
    const evidence = (response: unknown, observation: ReturnType<typeof beginModelObservation>) => {
        const candidates = object(response).candidates;
        if (!Array.isArray(candidates)) return;
        for (const candidate of candidates) {
            const parts = object(object(candidate).content).parts;
            if (Array.isArray(parts)) for (const part of parts) {
                const value = object(part);
                if (typeof value.text === "string" && value.text && value.thought !== true) observation.firstAnswer();
                if (value.functionCall) observation.capability("tools");
            }
            const chunks = object(object(candidate).groundingMetadata).groundingChunks;
            if (Array.isArray(chunks) && chunks.length) observation.capability("grounding");
        }
    };
    const wrapped: ObservedGeminiClient = { models: {
        async generateContent(params) {
            if (!scope.getStore()) return client.models.generateContent(params);
            const observation = beginModelObservation({ ...identity, modelId: params.model });
            if (requestsGrounding(params.config?.tools)) observation.requestGrounding();
            try {
                const response = await client.models.generateContent(params);
                evidence(response, observation);
                observation.finish({ usage: geminiUsage(response.usageMetadata, true) });
                return response;
            } catch (error) { observation.finish({ error, ...(params.config?.abortSignal?.aborted ? { status: "aborted" as const } : {}) }); throw error; }
        },
        async generateContentStream(params) {
            if (!scope.getStore()) return client.models.generateContentStream(params);
            const observation = beginModelObservation({ ...identity, modelId: params.model });
            if (requestsGrounding(params.config?.tools)) observation.requestGrounding();
            try {
                const stream = await client.models.generateContentStream(params);
                return (async function* () {
                    let usage: unknown;
                    let completed = false;
                    let terminal = false;
                    try {
                        for await (const chunk of stream) {
                            observation.capability("streaming");
                            evidence(chunk, observation);
                            if (chunk.usageMetadata) usage = chunk.usageMetadata;
                            if (chunk.candidates?.some((candidate) => !!candidate.finishReason)) terminal = true;
                            yield chunk;
                        }
                        completed = true;
                        observation.finish({ usage: geminiUsage(usage, terminal), status: terminal ? "success" : "unknown" });
                    } catch (error) { observation.finish({ error, ...(params.config?.abortSignal?.aborted ? { status: "aborted" as const } : {}) }); throw error; }
                    finally { if (!completed) observation.finish({ status: "aborted" }); }
                })();
            } catch (error) { observation.finish({ error, ...(params.config?.abortSignal?.aborted ? { status: "aborted" as const } : {}) }); throw error; }
        },
        async embedContent(params) {
            if (!scope.getStore()) return client.models.embedContent(params);
            const observation = withModelPurpose("embedding", () => beginModelObservation({ ...identity, modelId: params.model, purpose: "embedding" }));
            try {
                const response = await client.models.embedContent(params);
                observation.finish();
                return response;
            } catch (error) { observation.finish({ error, ...(params.config?.abortSignal?.aborted ? { status: "aborted" as const } : {}) }); throw error; }
        },
    } };
    originalClients.set(wrapped, client);
    return wrapped;
}
