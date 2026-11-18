import { stripMarkdown } from "@/lib/speech";

// Speaks a reply through /api/tts in chunks, scheduling each chunk's PCM straight after the last so playback
// has no gaps. One request runs at a time because the on-box voice has a single synthesis slot.

// Text queued while a chunk is being made goes out together, up to this size.
const BATCH_CHARS = 600;
// Matches FULL_TTS_CHARS in src/lib/ai/tts.ts, the most a single spoken reply ever covered.
export const SPOKEN_REPLY_MAX_CHARS = 1800;

export type SpeakerEnd = "done" | "error";

type Options = {
    freeOnly: boolean;
    /** Awaited once, just before the first audio plays (a filler phrase finishing). */
    beforeFirstAudio?: () => Promise<void>;
    onEnd: (end: SpeakerEnd, error?: unknown) => void;
    fetchImpl?: typeof fetch;
};

export class ReplySpeaker {
    private readonly abort = new AbortController();
    private readonly queue: string[] = [];
    private ctx: AudioContext | null = null;
    private playhead = 0;
    private pushedChars = 0;
    private running = false;
    private finished = false;
    private ended = false;
    private audible = false;

    constructor(private readonly options: Options) { }

    /** Queues text to speak. False once the reply has reached the spoken length limit. */
    push(text: string): boolean {
        if (this.ended || this.finished) return false;
        if (this.pushedChars > 0 && this.pushedChars + text.length > SPOKEN_REPLY_MAX_CHARS) return false;
        this.pushedChars += text.length;
        if (/[\p{L}\p{N}]/u.test(stripMarkdown(text))) {
            this.queue.push(text);
            void this.pump();
        }
        return true;
    }

    /** No more text will come; ends once everything queued has been spoken. */
    finish(): void {
        if (this.ended || this.finished) return;
        this.finished = true;
        void this.pump();
    }

    stop(): void {
        this.ended = true;
        this.abort.abort();
        this.closeAudio();
    }

    private async pump(): Promise<void> {
        if (this.running || this.ended) return;
        this.running = true;
        try {
            while (!this.ended && this.queue.length > 0) {
                let batch = this.queue.shift()!;
                while (this.queue.length > 0 && batch.length + this.queue[0].length <= BATCH_CHARS) batch += this.queue.shift();
                await this.speak(batch);
            }
            if (this.finished && !this.ended) {
                await this.untilPlayed();
                this.end("done");
            }
        } catch (error) {
            if (!this.abort.signal.aborted) this.end("error", error);
        } finally {
            this.running = false;
        }
    }

    private async speak(text: string): Promise<void> {
        const res = await (this.options.fetchImpl ?? fetch)("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, stream: true, freeOnly: this.options.freeOnly }),
            signal: this.abort.signal,
        });
        if (!res.ok || !res.body) {
            // A later chunk that cannot be spoken is skipped; the reply is still on screen.
            if (!this.audible) throw new Error(`TTS failed (${res.status})`);
            return;
        }
        const sampleRate = Number(res.headers.get("X-Sample-Rate") ?? 24000);
        if (!this.ctx) {
            await this.options.beforeFirstAudio?.();
            this.abort.signal.throwIfAborted();
            this.ctx = new AudioContext();
            if (this.ctx.state === "suspended") await this.ctx.resume();
            this.playhead = this.ctx.currentTime + 0.1;
        }

        // Coalesce small network reads into buffers of at least 0.2 s (50 ms for the very first, so sound starts
        // at once). PCM is 16-bit, so a buffer always holds an even number of bytes.
        const reader = res.body.getReader();
        let pending: Uint8Array[] = [];
        let pendingBytes = 0;
        const flush = () => {
            const even = pendingBytes - (pendingBytes % 2);
            if (even === 0) return;
            const merged = new Uint8Array(pendingBytes);
            let offset = 0;
            for (const part of pending) { merged.set(part, offset); offset += part.length; }
            this.schedule(merged.subarray(0, even), sampleRate);
            pending = pendingBytes > even ? [merged.subarray(even)] : [];
            pendingBytes -= even;
        };
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            this.abort.signal.throwIfAborted();
            pending.push(value);
            pendingBytes += value.length;
            if (pendingBytes >= (this.audible ? sampleRate * 0.4 : sampleRate * 0.1)) flush();
        }
        flush();
    }

    private schedule(bytes: Uint8Array, sampleRate: number): void {
        const ctx = this.ctx;
        if (!ctx || bytes.length < 2) return;
        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
        const buffer = ctx.createBuffer(1, int16.length, sampleRate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 32768;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        if (this.playhead < ctx.currentTime + 0.05) this.playhead = ctx.currentTime + 0.05;
        source.start(this.playhead);
        this.playhead += buffer.duration;
        this.audible = true;
    }

    private async untilPlayed(): Promise<void> {
        if (!this.ctx) return;
        const remainingMs = Math.max(0, (this.playhead - this.ctx.currentTime) * 1000) + 150;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, remainingMs);
            this.abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
    }

    private end(end: SpeakerEnd, error?: unknown): void {
        if (this.ended) return;
        this.ended = true;
        this.closeAudio();
        this.options.onEnd(end, error);
    }

    private closeAudio(): void {
        if (this.ctx) void this.ctx.close().catch(() => { });
        this.ctx = null;
    }
}
