import { CAPTURE_TEXT_MAX, RECORDING_MAX_SECONDS, RECORDING_PIECE_SECONDS, RECORDING_SAMPLE_RATE } from "@/lib/voice/recording-limits";

// Capture recordings (V8 F5, Decision 18): the browser decodes, resamples to 16 kHz mono and sends 3-minute pieces,
// so no request meets Cloudflare's 100 s cut and the box never holds the whole recording.

export const RECORDING_ACCEPT = "audio/*,.m4a,.mp3,.wav,.ogg,.oga,.opus,.webm,.flac,.aac";
const PIECE_SAMPLES = RECORDING_PIECE_SECONDS * RECORDING_SAMPLE_RATE;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_WAITS_MS = [2_000, 5_000];

/** Length from the file's metadata, read before decoding so an over-long file never fills memory. Null when the browser cannot tell. */
export function audioFileSeconds(file: Blob): Promise<number | null> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const audio = document.createElement("audio");
        const done = (value: number | null) => {
            clearTimeout(timer);
            audio.onloadedmetadata = audio.onerror = null;
            audio.removeAttribute("src");
            URL.revokeObjectURL(url);
            resolve(value);
        };
        const timer = setTimeout(() => done(null), 10_000);
        audio.preload = "metadata";
        // Recorder WebM often reports Infinity until played through; the decoded length is checked instead.
        audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
        audio.onerror = () => done(null);
        audio.src = url;
    });
}

/** Mono 16 kHz 16-bit PCM from decoded channels at any rate; each output sample averages the source samples it covers. */
export function mixToPcm(channels: readonly Float32Array[], rate: number): Int16Array<ArrayBuffer> {
    const length = channels[0]?.length ?? 0;
    const ratio = rate / RECORDING_SAMPLE_RATE;
    const out = new Int16Array(Math.floor(length / ratio));
    for (let index = 0; index < out.length; index++) {
        const start = Math.floor(index * ratio), end = Math.min(length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
        let sum = 0, count = 0;
        for (let at = start; at < end; at++) for (const channel of channels) { sum += channel[at]; count++; }
        const sample = count ? Math.max(-1, Math.min(1, sum / count)) : 0;
        out[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return out;
}

export interface Recording { seconds: number; pieces: number; piece(index: number): Uint8Array<ArrayBuffer> }

export function recordingFromPcm(pcm: Int16Array<ArrayBuffer>): Recording {
    return {
        seconds: pcm.length / RECORDING_SAMPLE_RATE,
        pieces: Math.ceil(pcm.length / PIECE_SAMPLES),
        piece: (index) => new Uint8Array(pcm.buffer.slice(index * PIECE_SAMPLES * 2, Math.min(pcm.length, (index + 1) * PIECE_SAMPLES) * 2)),
    };
}

/** Decoding asks for 16 kHz; a browser that refuses that rate decodes at 48 kHz and the mix resamples. Only the 16-bit copy is kept. */
export async function decodeRecording(file: Blob): Promise<Recording> {
    const data = await file.arrayBuffer();
    let context: OfflineAudioContext;
    try { context = new OfflineAudioContext(1, 1, RECORDING_SAMPLE_RATE); } catch { context = new OfflineAudioContext(1, 1, 48000); }
    let buffer: AudioBuffer;
    try { buffer = await context.decodeAudioData(data); } catch {
        throw new Error("This recording could not be decoded in the browser. The format may not be supported here, or the file may be too long for this device's memory. Try a shorter file or another format.");
    }
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const recording = recordingFromPcm(mixToPcm(channels, buffer.sampleRate));
    if (recording.seconds > RECORDING_MAX_SECONDS + 1) throw new Error("This recording is over 2 hours. Trim it or split it first.");
    if (!recording.pieces) throw new Error("This recording has no audio.");
    return recording;
}

export interface RecordingTranscript { text: string; done: number; total: number; models: string[]; stopped: boolean; failed?: string }
type Send = (piece: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<Response>;

const sendPiece: Send = (piece, signal) => fetch("/api/capture/transcribe-piece", {
    method: "POST", body: piece, headers: { "Content-Type": "application/octet-stream" }, cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(110_000)]),
});

async function onePiece(piece: Uint8Array<ArrayBuffer>, signal: AbortSignal, send: Send, wait: (ms: number) => Promise<void>): Promise<{ text: string; model: string | null }> {
    let failed = "The piece could not be transcribed.";
    for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
        if (attempt) await wait(RETRY_WAITS_MS[attempt - 1]);
        signal.throwIfAborted();
        const response = await send(piece, signal).catch((error) => { if (signal.aborted) throw error; return null; });
        if (!response) continue;
        if (response.status === 401) throw new Error("Sign in again to use the capture inbox.");
        const data = await response.json().catch(() => ({})) as { text?: unknown; model?: unknown; error?: unknown };
        if (response.ok && typeof data.text === "string") return { text: data.text.trim(), model: typeof data.model === "string" ? data.model : null };
        failed = typeof data.error === "string" ? data.error : failed;
        if (!RETRY_STATUSES.has(response.status)) throw new Error(failed);
    }
    throw new Error(failed);
}

/** Pieces go one at a time, in order. Stopping or a piece that keeps failing returns the text so far. */
export async function transcribeRecording(recording: Recording, options: {
    signal: AbortSignal; onProgress?: (done: number, total: number) => void; send?: Send; wait?: (ms: number) => Promise<void>;
}): Promise<RecordingTranscript> {
    const send = options.send ?? sendPiece;
    const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const texts: string[] = [], models = new Set<string>();
    const result = (done: number, extra: Partial<RecordingTranscript> = {}): RecordingTranscript =>
        ({ text: texts.filter(Boolean).join(" "), done, total: recording.pieces, models: [...models], stopped: false, ...extra });
    for (let index = 0; index < recording.pieces; index++) {
        if (options.signal.aborted) return result(index, { stopped: true });
        options.onProgress?.(index, recording.pieces);
        try {
            const heard = await onePiece(recording.piece(index), options.signal, send, wait);
            texts.push(heard.text);
            if (heard.model) models.add(heard.model);
        } catch (error) {
            if (options.signal.aborted) return result(index, { stopped: true });
            if (error instanceof Error && /^Sign in again/.test(error.message)) throw error;
            return result(index, { failed: error instanceof Error ? error.message : "The piece could not be transcribed." });
        }
    }
    return result(recording.pieces);
}

/** The capture body: the summary, then the transcript, cut to what a capture holds. */
export function recordingBody(summary: string | null, transcript: string): { text: string; cut: boolean } {
    const head = summary?.trim() ? `${summary.trim()}\n\n## Transcript\n\n` : "";
    const room = CAPTURE_TEXT_MAX - head.length;
    return transcript.length > room ? { text: head + transcript.slice(0, room), cut: true } : { text: head + transcript, cut: false };
}
