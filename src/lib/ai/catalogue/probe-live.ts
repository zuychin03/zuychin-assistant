import { LIVE_SAMPLE_RATE, sdkLiveClient, type LiveClient, type LiveTurnResult } from "@/lib/ai/media/live";
import type { MediaFailure, MediaRoute } from "@/lib/ai/media/requests";
import type { ModelTraits } from "@/lib/ai/catalogue/snapshot";
import { failedProbe, failedStep, type MediaProbeResult } from "@/lib/ai/catalogue/probe-media";
import { beginModelObservation } from "@/lib/ai/model-observations";

export const LIVE_PROBE_TEXT = "In one short sentence, say good morning and that the probe works.";
// First audio came 3.9 s after connecting on 24/11/2026.
export const LIVE_PROBE_TIMEOUT_MS = 15_000;
const BYTES_PER_SECOND = LIVE_SAMPLE_RATE * 2;

function turnDetail(turn: LiveTurnResult, audioSec: number, ok: boolean): string {
    if (ok) return `${audioSec} s of audio: "${turn.transcript.trim().slice(0, 80)}"`;
    if (turn.outcome === "timeout") return `No finished reply within ${LIVE_PROBE_TIMEOUT_MS / 1000} s.`;
    if (turn.outcome === "closed") return `The session closed: ${turn.closeReason ?? "no reason given"}.`;
    return turn.audioBytes ? "No transcript came back." : "No audio came back.";
}

/** A token locked to the model, one session and one text turn: audio and a transcript within 15 s. */
export async function probeLive(route: MediaRoute, client: LiveClient = sdkLiveClient): Promise<MediaProbeResult> {
    const observation = beginModelObservation({ providerId: route.provider.id, modelId: route.modelId, purpose: "probe" });
    const token = await client.createToken(route, { expireMs: 2 * 60_000, newSessionMs: 60_000 });
    if (!token.ok) {
        observation.finish({ error: token.status === null ? { name: "TypeError" } : { status: token.status } });
        return failedProbe("token", token);
    }
    const tokenStep = { outcome: "pass" as const, httpStatus: 200, ms: token.ms, detail: null };
    const started = performance.now();
    let turn: LiveTurnResult;
    try {
        turn = await client.textTurn(token.token, route.modelId, LIVE_PROBE_TEXT, LIVE_PROBE_TIMEOUT_MS);
    } catch (error) {
        const failure: MediaFailure = {
            ok: false, status: null, ms: Math.round(performance.now() - started), transient: true, timedOut: false, retiredAt: null,
            error: `Could not connect: ${error instanceof Error ? error.message : String(error)}`,
        };
        observation.finish({ error: { name: "TypeError" } });
        return { ...failedProbe("live", failure), steps: { token: tokenStep, live: failedStep(failure) } };
    }
    const ms = Math.round(performance.now() - started);
    const ok = turn.outcome === "complete" && turn.audioBytes > 0 && turn.transcript.trim().length > 0;
    if (turn.firstAudioMs !== null) observation.firstAnswer();
    observation.finish(ok ? {} : { error: { name: turn.outcome === "timeout" ? "TimeoutError" : "TypeError" } });
    const audioSec = Math.round((turn.audioBytes / BYTES_PER_SECOND) * 10) / 10;
    const traits: ModelTraits = ok ? { audioFormat: "pcm", sampleRate: LIVE_SAMPLE_RATE, channels: 1, audioSec, ...(turn.firstAudioMs !== null ? { firstAudioMs: turn.firstAudioMs } : {}) } : {};
    // A timeout or a dropped session may be the network; a finished turn without audio is a real failure.
    const outcome = ok ? "pass" : turn.outcome === "complete" ? "fail" : "transient";
    return {
        status: ok ? "passed" : outcome === "fail" ? "failed" : "inconclusive", retired: false, retiredAt: null, ms: turn.firstAudioMs, traits,
        steps: { token: tokenStep, live: { outcome, httpStatus: null, ms, detail: turnDetail(turn, audioSec, ok) } },
    };
}
