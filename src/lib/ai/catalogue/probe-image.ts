import { requestImage, type MediaRoute } from "@/lib/ai/media/requests";
import { failedProbe, observedProbeCall, type MediaProbeOptions, type MediaProbeResult } from "@/lib/ai/catalogue/probe-media";

export const IMAGE_PROBE_PROMPT = "A flat illustration of a desk lamp lighting an open notebook, soft colours";
export const IMAGE_PROBE_SIZE = 768;
const PROBE_TIMEOUT_MS = 60_000;
const MIN_BYTES = 2_000;

export async function probeImage(route: MediaRoute, options: MediaProbeOptions = {}): Promise<MediaProbeResult> {
    const size = `${IMAGE_PROBE_SIZE}x${IMAGE_PROBE_SIZE}`;
    const result = await observedProbeCall(route, () => requestImage(route, { prompt: IMAGE_PROBE_PROMPT, width: IMAGE_PROBE_SIZE, height: IMAGE_PROBE_SIZE }, { ...options, timeoutMs: PROBE_TIMEOUT_MS }));
    if (!result.ok) return failedProbe("image", result);
    const ok = result.value.bytes.length >= MIN_BYTES;
    const kb = Math.round(result.value.bytes.length / 1024);
    return {
        status: ok ? "passed" : "failed", retired: false, retiredAt: null, ms: result.ms, traits: ok ? { sizes: [size] } : {},
        steps: { image: { outcome: ok ? "pass" : "fail", httpStatus: result.status, ms: result.ms, detail: `${size} ${result.value.mimeType.slice(6).toUpperCase()}, ${kb} KB${ok ? "." : ", too small to be a picture."}` } },
    };
}
