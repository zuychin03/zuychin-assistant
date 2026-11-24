import { STT_SAMPLE_RATE } from "@/lib/voice/stt-client";

// Feeding 16 KB of Ogg at a time kept the box's peak lowest: a 5-minute note decoded
// in 2.6 s with 47 MB extra (P2 gate, 21/11/2026), against 55 MB for 64 KB.
const CHUNK_BYTES = 16 * 1024;

export type VoiceDecodeFailure = "too_long" | "empty" | "invalid";

export class VoiceDecodeError extends Error {
    constructor(readonly reason: VoiceDecodeFailure) {
        super(`Voice note could not be decoded: ${reason}`);
        this.name = "VoiceDecodeError";
    }
}

type DecodedAudio = { channelData: Float32Array[]; samplesDecoded: number };

const OGG_PAGE = [0x4f, 0x67, 0x67, 0x53];
const pageAt = (bytes: Uint8Array, at: number) => at + 27 <= bytes.length && OGG_PAGE.every((byte, index) => bytes[at + index] === byte) && bytes[at + 4] === 0;

/** Length of an Ogg Opus file from its last page's granule position, without decoding; null when it is not Ogg Opus. */
export function oggOpusSeconds(bytes: Uint8Array): number | null {
    if (!pageAt(bytes, 0)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const head = 27 + bytes[26];
    if (head + 12 > bytes.length || new TextDecoder().decode(bytes.subarray(head, head + 8)) !== "OpusHead") return null;
    const preSkip = view.getUint16(head + 10, true), serial = view.getUint32(14, true);
    for (let at = bytes.length - 27; at > 0; at--) {
        if (!pageAt(bytes, at) || view.getUint32(at + 14, true) !== serial) continue;
        // Opus granule positions always count 48 kHz samples.
        const granule = Number(view.getBigUint64(at + 6, true));
        return granule > preSkip ? (granule - preSkip) / 48000 : null;
    }
    return null;
}

/** Ogg Opus to 16 kHz mono s16le, in pieces of at most pieceSeconds. libopus resamples while decoding. */
export async function decodeOggOpus(bytes: Uint8Array, options: { maxSeconds: number; pieceSeconds: number }): Promise<Uint8Array<ArrayBuffer>[]> {
    const { OggOpusDecoder } = await import("ogg-opus-decoder");
    // sampleRate (8, 12, 16, 24 or 48 kHz) works at runtime but is missing from the package's types.
    const decoder = new OggOpusDecoder({ sampleRate: STT_SAMPLE_RATE } as ConstructorParameters<typeof OggOpusDecoder>[0]);
    const pieceSamples = options.pieceSeconds * STT_SAMPLE_RATE;
    const maxSamples = options.maxSeconds * STT_SAMPLE_RATE;
    const pieces: Uint8Array<ArrayBuffer>[] = [];
    let piece = new Int16Array(pieceSamples);
    let filled = 0;
    let total = 0;

    const take = (audio: DecodedAudio) => {
        const count = audio.samplesDecoded;
        if (!count) return;
        total += count;
        if (total > maxSamples) throw new VoiceDecodeError("too_long");
        const channels = audio.channelData;
        for (let i = 0; i < count; i++) {
            let sample = channels[0][i];
            if (channels.length > 1) {
                sample = 0;
                for (const channel of channels) sample += channel[i];
                sample /= channels.length;
            }
            sample = sample < -1 ? -1 : sample > 1 ? 1 : sample;
            piece[filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            if (filled === pieceSamples) {
                pieces.push(new Uint8Array(piece.buffer));
                piece = new Int16Array(pieceSamples);
                filled = 0;
            }
        }
    };

    try {
        await decoder.ready;
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
            take(await decoder.decode(bytes.subarray(offset, offset + CHUNK_BYTES)));
        }
        take(await decoder.flush());
    } catch (error) {
        throw error instanceof VoiceDecodeError ? error : new VoiceDecodeError("invalid");
    } finally {
        decoder.free();
    }
    if (filled > 0) pieces.push(new Uint8Array(piece.buffer.slice(0, filled * 2)));
    if (pieces.length === 0) throw new VoiceDecodeError("empty");
    return pieces;
}
