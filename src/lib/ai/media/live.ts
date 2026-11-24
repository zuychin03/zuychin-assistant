import type { MediaFailure, MediaRoute } from "@/lib/ai/media/requests";

// Gemini Live: ephemeral tokens made on the server, sessions opened with the token. The SDK marks tokens experimental.

export const LIVE_SAMPLE_RATE = 24_000;

export interface LiveTokenRequest {
    /** Token lifetime, and the window in which a new session may start. */
    expireMs: number;
    newSessionMs: number;
    /** Locked connect config: the client cannot change it. */
    config?: Record<string, unknown>;
}

export interface LiveTurnResult {
    /** "complete" when the model finished its turn. */
    outcome: "complete" | "timeout" | "closed";
    firstAudioMs: number | null;
    audioBytes: number;
    transcript: string;
    closeReason: string | null;
}

export interface LiveClient {
    createToken(route: MediaRoute, request: LiveTokenRequest): Promise<{ ok: true; token: string; ms: number } | MediaFailure>;
    /** Opens a session with the token, sends one text turn and collects the reply. */
    textTurn(token: string, modelId: string, text: string, timeoutMs: number): Promise<LiveTurnResult>;
}

function sdkFailure(error: unknown, ms: number): MediaFailure {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : null;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status, ms, error: message.slice(0, 300), transient: status === null || status === 429 || status >= 500, timedOut: false, retiredAt: null };
}

/** The real client. Imported lazily so routes that never use Live do not load the SDK's WebSocket code. */
export const sdkLiveClient: LiveClient = {
    async createToken(route, request) {
        const started = performance.now();
        try {
            const { GoogleGenAI, Modality } = await import("@google/genai");
            const ai = new GoogleGenAI({ apiKey: route.apiKey, httpOptions: { apiVersion: "v1beta" } });
            const now = Date.now();
            const token = await ai.authTokens.create({
                config: {
                    uses: 1,
                    expireTime: new Date(now + request.expireMs).toISOString(),
                    newSessionExpireTime: new Date(now + request.newSessionMs).toISOString(),
                    liveConnectConstraints: { model: route.modelId, config: { responseModalities: [Modality.AUDIO], ...request.config } },
                },
            });
            const ms = Math.round(performance.now() - started);
            return token.name ? { ok: true, token: token.name, ms } : sdkFailure(new Error("The token reply had no name."), ms);
        } catch (error) {
            return sdkFailure(error, Math.round(performance.now() - started));
        }
    },
    async textTurn(token, modelId, text, timeoutMs) {
        const { GoogleGenAI, Modality } = await import("@google/genai");
        const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1beta" } });
        const started = performance.now();
        const result: LiveTurnResult = { outcome: "timeout", firstAudioMs: null, audioBytes: 0, transcript: "", closeReason: null };
        let finish: () => void = () => {};
        const done = new Promise<void>((resolve) => { finish = resolve; });
        const timer = setTimeout(finish, timeoutMs);
        const session = await ai.live.connect({
            model: modelId,
            config: { responseModalities: [Modality.AUDIO], outputAudioTranscription: {} },
            callbacks: {
                onmessage: (message) => {
                    for (const part of message.serverContent?.modelTurn?.parts ?? []) {
                        if (!part.inlineData?.data) continue;
                        result.firstAudioMs ??= Math.round(performance.now() - started);
                        result.audioBytes += Buffer.from(part.inlineData.data, "base64").length;
                    }
                    if (message.serverContent?.outputTranscription?.text) result.transcript += message.serverContent.outputTranscription.text;
                    if (message.serverContent?.turnComplete) { result.outcome = "complete"; finish(); }
                },
                onerror: (event) => { result.outcome = "closed"; result.closeReason = (event as { message?: string })?.message ?? "error"; finish(); },
                onclose: (event) => {
                    if (result.outcome === "timeout") { result.outcome = "closed"; result.closeReason = `${event?.code ?? ""} ${event?.reason ?? ""}`.trim() || "closed"; }
                    finish();
                },
            },
        }).catch((error) => { clearTimeout(timer); throw error; });
        try {
            session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
            await done;
        } finally {
            clearTimeout(timer);
            try { session.close(); } catch { /* already closed */ }
        }
        return result;
    },
};
