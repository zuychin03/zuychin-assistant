// Turns a MediaRecorder blob (WebM/Opus in Chrome, MP4/AAC in Safari) into the 16 kHz mono 16-bit PCM
// the on-box transcriber takes, so the box needs no ffmpeg.

export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_MAX_SECONDS = 60;

export function resampledLength(durationSec: number, rate = VOICE_SAMPLE_RATE): number {
    return Math.max(1, Math.ceil(durationSec * rate));
}

export function floatToPcm16(samples: Float32Array): Int16Array<ArrayBuffer> {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
}

// The offline render mixes every channel down to the one output channel and resamples on the way.
export async function blobTo16kPcm(blob: Blob): Promise<Int16Array<ArrayBuffer>> {
    const context = new AudioContext();
    let decoded: AudioBuffer;
    try {
        decoded = await context.decodeAudioData(await blob.arrayBuffer());
    } finally {
        void context.close().catch(() => { });
    }
    const offline = new OfflineAudioContext(1, resampledLength(decoded.duration), VOICE_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return floatToPcm16((await offline.startRendering()).getChannelData(0));
}

// Returns the transcript, or null when the turn should be sent as audio instead.
export async function transcribeVoiceBlob(blob: Blob, signal?: AbortSignal): Promise<string | null> {
    try {
        const pcm = await blobTo16kPcm(blob);
        if (pcm.length > VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE) return null;
        const timeout = AbortSignal.timeout(20_000);
        const res = await fetch("/api/voice/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: pcm,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) return null;
        const body = await res.json() as { text?: unknown };
        return typeof body.text === "string" && body.text.trim() ? body.text.trim() : null;
    } catch {
        return null;
    }
}
