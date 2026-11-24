import { beginModelObservation, withModelPurpose, type ModelCallPurpose } from "@/lib/ai/model-observations";
import type { MediaFailure, MediaRoute } from "@/lib/ai/media/requests";

/**
 * Records one media call in the model observations. Starting the observation checks the data policy, so a refused route
 * throws before any request is sent.
 */
export async function observedMediaCall<T extends { ok: boolean }>(route: MediaRoute, purpose: ModelCallPurpose, call: () => Promise<T>): Promise<T> {
    const observation = withModelPurpose(purpose, () => beginModelObservation({ providerId: route.provider.id, modelId: route.modelId, purpose }));
    try {
        const result = await call();
        if (result.ok) { observation.firstAnswer(); observation.finish(); }
        else {
            const failure = result as unknown as MediaFailure;
            observation.finish({ error: failure.status === null ? { name: failure.timedOut ? "TimeoutError" : "TypeError" } : { status: failure.status } });
        }
        return result;
    } catch (error) {
        observation.finish({ error: { name: error instanceof Error ? error.name : "Error" } });
        throw error;
    }
}
